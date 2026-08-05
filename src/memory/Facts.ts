import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../logging/logger.js';
import { ensureDir } from '../workspace/WorkspaceContext.js';
import { Entry, EntryKind, clamp01, formatEntry, makeId, parseEntries, todayIso } from './format.js';

export interface FactCandidate {
  text: string;
  anchors?: string[];
  kind?: EntryKind;
  confidence?: number;
}

export interface MergeReport {
  added: Entry[];
  reinforced: Entry[];
  superseded: Array<{ old: Entry; by: Entry }>;
  rejected: Array<{ text: string; reason: string }>;
}

export interface VerifyReport {
  checked: number;
  ok: number;
  weakened: Entry[];
  archived: Entry[];
  /** Facts whose anchored code was edited since the claim was recorded. */
  changed: Entry[];
}

/**
 * Confidence multiplier when the anchored code has been edited. Gentler than a
 * missing file: the claim may well still hold, it simply is not proven any more.
 */
const CHANGED_PENALTY = 0.7;

/** Two facts this similar are treated as the same claim. */
const SAME_FACT = 0.72;
/**
 * A restatement about the same file must be at least this close before it may
 * replace what is stored. One file carries many unrelated facts, so a loose
 * threshold here quietly deletes true claims that merely share a neighbourhood.
 */
const RESTATEMENT = 0.62;
/**
 * How alike two claims must read once their numbers are removed before a
 * differing number counts as a contradiction rather than a separate fact.
 * Measured separation is wide: identical claims score 1.00, claims about
 * different subjects score 0.53-0.66.
 */
const SAME_SUBJECT = 0.9;

const NEW_FACT_CONFIDENCE = 0.6;
const REINFORCE_STEP = 0.12;
const MAX_CONFIDENCE = 0.98;
/** Facts below this are retired to the archive rather than deleted. */
const ARCHIVE_FLOOR = 0.25;

const MAX_ANCHORS_PER_FACT = 4;
const MAX_TEXT_LENGTH = 220;

/**
 * The semantic layer: durable claims about the codebase, one per line, each
 * backed by `file:line` anchors.
 *
 * Merging is deliberately deterministic — the model proposes candidates but
 * never rewrites the file. Letting a model rewrite an accumulated context
 * wholesale is the documented "context collapse" failure, where the artifact
 * shrinks below the no-memory baseline in a single step.
 */
export class FactsStore {
  private readonly root: string;
  private readonly file: string;
  private readonly archiveFile: string;

  constructor(root: string, memoryDir: string) {
    this.root = root;
    this.file = path.join(memoryDir, 'FACTS.md');
    this.archiveFile = path.join(memoryDir, 'ARCHIVE.md');
  }

  public load(): Entry[] {
    return parseEntries(readFile(this.file));
  }

  public save(entries: Entry[]): void {
    const byKind = new Map<EntryKind, Entry[]>();
    for (const entry of entries) {
      const bucket = byKind.get(entry.kind) || [];
      bucket.push(entry);
      byKind.set(entry.kind, bucket);
    }

    const sections: string[] = [
      '# Facts',
      '',
      'What we know about this codebase. One claim per line, with the `file:line` that backs it.',
      'Format: `- [id] claim @anchors #kind xHits cConfidence date`',
      '',
    ];

    for (const kind of [...byKind.keys()].sort()) {
      const bucket = byKind.get(kind)!.sort((a, b) => b.confidence - a.confidence);
      sections.push(`## ${kind}`, '');
      for (const entry of bucket) sections.push(formatEntry(entry));
      sections.push('');
    }

    ensureDir(path.dirname(this.file));
    fs.writeFileSync(this.file, sections.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf-8');
  }

  // ----------------------------------------------------------------- merge

  /**
   * Fold candidate facts into the store.
   *
   * Each candidate either reinforces an existing fact, supersedes one it
   * contradicts, or is added. Nothing already stored is discarded silently.
   */
  public merge(candidates: FactCandidate[]): MergeReport {
    const entries = this.load();
    const report: MergeReport = { added: [], reinforced: [], superseded: [], rejected: [] };
    if (candidates.length === 0) return report;

    const taken = new Set(entries.map((e) => e.id));
    const retired: Entry[] = [];

    for (const candidate of candidates) {
      const text = candidate.text?.trim();
      if (!text) {
        report.rejected.push({ text: String(candidate.text), reason: 'empty' });
        continue;
      }
      if (text.length > MAX_TEXT_LENGTH) {
        report.rejected.push({ text: text.slice(0, 60), reason: `longer than ${MAX_TEXT_LENGTH} chars` });
        continue;
      }

      const kind = candidate.kind || 'gotcha';
      const anchors = normalizeAnchors(candidate.anchors, this.root);
      const match = findClosest(entries, text);
      // "port 6777" and "port 8080" differ by three characters and score as the
      // same claim. Treating that as a repeat would quietly keep the stale
      // value, so a changed value outranks textual similarity.
      const contradiction = match ? contradicts(match.entry.text, text) : false;
      // Guards every merge path: a claim naming different things is a different
      // claim, no matter how alike the sentences read.
      const aboutTheSameThing = match ? sameClaim(match.entry.text, text) : false;

      // Same claim, seen again — reinforce instead of duplicating.
      if (match && match.score >= SAME_FACT && aboutTheSameThing && !contradiction) {
        const existing = match.entry;
        existing.hits += 1;
        existing.confidence = clamp01(Math.min(MAX_CONFIDENCE, existing.confidence + REINFORCE_STEP));
        existing.anchors = mergeAnchors(existing.anchors, anchors);
        existing.date = todayIso();
        // Seeing the claim again against the current code re-proves it.
        existing.fingerprint = this.fingerprintOf(existing.anchors) ?? existing.fingerprint;
        delete existing.stale;
        // A longer restatement of the same claim usually carries more detail.
        if (text.length > existing.text.length * 1.25) existing.text = text;
        report.reinforced.push(existing);
        continue;
      }

      // The codebase changed under us: either the same sentence now carries a
      // different value, or a related claim about the same file was restated.
      // Retire the old version, keep it in the archive.
      if (
        match &&
        (contradiction ||
          (match.score >= RESTATEMENT &&
            aboutTheSameThing &&
            match.entry.kind === kind &&
            anchors.length > 0 &&
            sharesAnchorFile(match.entry.anchors, anchors)))
      ) {
        const replacement: Entry = {
          id: makeId(taken),
          text,
          anchors,
          kind,
          hits: 0,
          confidence: clamp01(candidate.confidence ?? NEW_FACT_CONFIDENCE),
          date: todayIso(),
          fingerprint: this.fingerprintOf(anchors),
        };
        taken.add(replacement.id);
        const old = match.entry;
        old.supersededBy = replacement.id;
        retired.push(old);
        entries.splice(entries.indexOf(old), 1);
        entries.push(replacement);
        report.superseded.push({ old, by: replacement });
        continue;
      }

      const entry: Entry = {
        id: makeId(taken),
        text,
        anchors,
        kind,
        hits: 0,
        confidence: clamp01(candidate.confidence ?? NEW_FACT_CONFIDENCE),
        date: todayIso(),
        fingerprint: this.fingerprintOf(anchors),
      };
      taken.add(entry.id);
      entries.push(entry);
      report.added.push(entry);
    }

    this.save(entries);
    if (retired.length > 0) this.appendArchive(retired, 'superseded');
    return report;
  }

  /** Record that these facts were served, so retrieval can reward what earns its place. */
  public recordHits(ids: string[]): void {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const entries = this.load();
    let changed = false;
    for (const entry of entries) {
      if (wanted.has(entry.id)) {
        entry.hits += 1;
        changed = true;
      }
    }
    if (changed) this.save(entries);
  }

  // ---------------------------------------------------------------- verify

  /**
   * Re-check every anchor against the working tree.
   *
   * A fact whose file is gone loses most of its confidence; once it falls
   * below the floor it moves to the archive. Entries are invalidated, never
   * hard-deleted, so a wrong retirement stays recoverable.
   */
  public verify(entries = this.load(), persist = true): VerifyReport {
    const report: VerifyReport = { checked: 0, ok: 0, weakened: [], archived: [], changed: [] };
    const survivors: Entry[] = [];
    const archived: Entry[] = [];

    for (const entry of entries) {
      if (entry.anchors.length === 0) {
        survivors.push(entry);
        continue;
      }

      report.checked++;
      const results = entry.anchors.map((anchor) => this.checkAnchor(anchor));
      const missing = results.filter((r) => r === 'missing').length;
      const outOfRange = results.filter((r) => r === 'out-of-range').length;

      if (missing === 0 && outOfRange === 0) {
        // The file is intact — but is it still the same code? An anchor proves
        // a line exists, not that it says what the claim was made about.
        const current = this.fingerprintOf(entry.anchors);

        if (entry.fingerprint && current && current !== entry.fingerprint) {
          entry.confidence = clamp01(entry.confidence * CHANGED_PENALTY);
          entry.stale = true;
          // Adopt the new fingerprint so the same edit is not charged twice;
          // the stale flag carries the warning until the fact is re-observed.
          entry.fingerprint = current;
          entry.date = todayIso();
          report.changed.push(entry);
          survivors.push(entry);
          continue;
        }

        // First sighting under the new scheme, or unchanged code.
        if (!entry.fingerprint && current) entry.fingerprint = current;
        report.ok++;
        entry.date = todayIso();
        survivors.push(entry);
        continue;
      }

      // Prune dead anchors only while a live one remains. A fact stripped of
      // its last anchor would become unverifiable, and therefore immortal —
      // it must stay checkable so repeated failures can retire it.
      if (results.some((r) => r === 'ok')) {
        entry.anchors = entry.anchors.filter((_, i) => results[i] !== 'missing');
      }
      const penalty = missing > 0 ? 0.5 : 0.8;
      entry.confidence = clamp01(entry.confidence * penalty);

      if (entry.confidence < ARCHIVE_FLOOR) {
        archived.push(entry);
        report.archived.push(entry);
      } else {
        report.weakened.push(entry);
        survivors.push(entry);
      }
    }

    if (persist) {
      this.save(survivors);
      if (archived.length > 0) this.appendArchive(archived, 'anchor no longer resolves');
    }
    return report;
  }

  /**
   * Re-check only the given facts and write back any change to their standing.
   *
   * Used on the retrieval path: verifying ten facts about to be injected costs
   * a handful of file reads, while verifying the whole store would not be
   * affordable on every call.
   */
  public verifySubset(subset: Entry[]): VerifyReport {
    const report = this.verify(subset, false);
    if (report.changed.length === 0 && report.weakened.length === 0 && report.archived.length === 0) {
      return report;
    }

    const updated = new Map(subset.map((e) => [e.id, e]));
    const archivedIds = new Set(report.archived.map((e) => e.id));
    const all = this.load().flatMap((entry) => {
      if (archivedIds.has(entry.id)) return [];
      const replacement = updated.get(entry.id);
      return [replacement ?? entry];
    });

    this.save(all);
    if (report.archived.length > 0) this.appendArchive(report.archived, 'anchor no longer resolves');
    return report;
  }

  /**
   * A short hash of the code the anchors point at.
   *
   * Line anchors hash just those lines, so an edit elsewhere in a busy file
   * does not invalidate an unrelated claim. File anchors fall back to the size
   * and opening bytes, which is cheap and still catches a rewrite.
   */
  public fingerprintOf(anchors: string[]): string | undefined {
    const parts: string[] = [];

    for (const anchor of anchors) {
      const [relPath, lineText] = splitAnchor(anchor);
      const absolute = path.resolve(this.root, relPath);
      try {
        const stat = fs.statSync(absolute);
        if (!stat.isFile()) continue;

        if (!lineText || stat.size > 2_000_000) {
          parts.push(`${relPath}:${stat.size}`);
          continue;
        }

        const lines = fs.readFileSync(absolute, 'utf-8').split('\n');
        const [start, end] = lineRange(anchor);
        const slice = lines.slice(Math.max(0, start - 1), end).join('\n').trim();
        parts.push(`${relPath}:${slice}`);
      } catch {
        /* unreadable — contributes nothing, handled by the anchor check */
      }
    }

    if (parts.length === 0) return undefined;
    return crypto.createHash('sha1').update(parts.join(' ')).digest('hex').slice(0, 8);
  }

  private checkAnchor(anchor: string): 'ok' | 'missing' | 'out-of-range' {
    const [relPath, lineText] = splitAnchor(anchor);
    const absolute = path.resolve(this.root, relPath);
    if (!fs.existsSync(absolute)) return 'missing';
    if (!lineText) return 'ok';

    const line = parseInt(lineText, 10);
    if (!Number.isFinite(line) || line <= 0) return 'ok';

    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) return 'missing';
      // Only count lines for files small enough that it stays cheap.
      if (stat.size > 2_000_000) return 'ok';
      const lineCount = fs.readFileSync(absolute, 'utf-8').split('\n').length;
      return line <= lineCount ? 'ok' : 'out-of-range';
    } catch {
      return 'ok';
    }
  }

  // --------------------------------------------------------------- archive

  private appendArchive(entries: Entry[], reason: string): void {
    if (entries.length === 0) return;
    ensureDir(path.dirname(this.archiveFile));

    let doc = readFile(this.archiveFile);
    if (!doc.trim()) {
      doc = '# Archive\n\nRetired facts. Kept so a wrong retirement stays recoverable.\n';
    }

    const block = [`\n## ${todayIso()} — ${reason}`, '', ...entries.map(formatEntry), ''].join('\n');
    fs.writeFileSync(this.archiveFile, `${doc.replace(/\s+$/, '')}\n${block}`, 'utf-8');
    logger.info(`[Memory] Archived ${entries.length} fact(s): ${reason}`);
  }
}

// ------------------------------------------------------------- similarity

/** Character trigrams of the normalized text, used for near-duplicate detection. */
export function trigrams(text: string): Set<string> {
  const normalized = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')} `;
  const grams = new Set<string>();
  for (let i = 0; i < normalized.length - 2; i++) grams.add(normalized.slice(i, i + 3));
  return grams;
}

/** Jaccard overlap of two trigram sets: 0 = unrelated, 1 = identical. */
export function similarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * Standalone numbers — ports, sizes, timeouts, status codes.
 *
 * The lookarounds matter: a number glued to letters (`Zx500`, `UserV2`,
 * `mod3.ts`, `billing_v2`) names a thing rather than measuring one. Treating
 * those as values makes every claim about a numbered entity look like a
 * restatement of every other, which silently deletes almost all of them.
 */
const VALUE_TOKEN = /(?<![A-Za-z_\d])\d+(?:[.:]\d+)*(?![A-Za-z_])/g;

/** Identifiers: tokens mixing letters and digits, which name a specific thing. */
const ENTITY_TOKEN = /\b(?=[A-Za-z_]*\d)(?=\d*[A-Za-z_])[A-Za-z0-9_]+\b/g;

/** The claim with its measurements removed: what it is about, minus what it says. */
function skeleton(text: string): string {
  return text.replace(VALUE_TOKEN, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The named things a claim is about. Two claims naming different entities are
 * different claims however alike they read — `Zx500` and `Zx600` differ by one
 * character and have nothing to do with each other.
 */
function entities(text: string): Set<string> {
  return new Set((text.match(ENTITY_TOKEN) || []).map((t) => t.toLowerCase()));
}

function sameEntities(a: string, b: string): boolean {
  const left = entities(a);
  const right = entities(b);
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/**
 * True when two claims say the same thing about different values.
 *
 * Trigram similarity cannot see this on its own: "listens on port 6777" and
 * "listens on port 8080" overlap almost entirely, yet only one can be true.
 *
 * Differing numbers are not enough on their own, though — "an invoice over 5 MB
 * is rejected" and "an avatar over 2 MB is rejected" are both true. So the
 * wording around the numbers must match too before one claim may replace the
 * other.
 */
export function contradicts(a: string, b: string): boolean {
  const left = new Set(a.match(VALUE_TOKEN) || []);
  const right = new Set(b.match(VALUE_TOKEN) || []);
  if (left.size === 0 || right.size === 0) return false;

  let differs = left.size !== right.size;
  if (!differs) {
    for (const value of left) {
      if (!right.has(value)) {
        differs = true;
        break;
      }
    }
  }
  if (!differs) return false;

  if (!sameEntities(a, b)) return false;
  return similarity(skeleton(a), skeleton(b)) >= SAME_SUBJECT;
}

/**
 * Whether a stored claim may be replaced or reinforced by a new one.
 *
 * Textual similarity alone is not enough: two facts about `mod3` and `mod7`
 * read almost identically. Naming different things is disqualifying.
 */
export function sameClaim(a: string, b: string): boolean {
  return sameEntities(a, b);
}

function findClosest(entries: Entry[], text: string): { entry: Entry; score: number } | undefined {
  let best: { entry: Entry; score: number } | undefined;
  for (const entry of entries) {
    const score = similarity(entry.text, text);
    if (!best || score > best.score) best = { entry, score };
  }
  return best;
}

// ----------------------------------------------------------------- anchors

/** The first and last line an anchor covers; a bare line anchor covers itself. */
function lineRange(anchor: string): [number, number] {
  const match = /:(\d+)(?:-(\d+))?$/.exec(anchor);
  if (!match) return [1, 1];
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;
  return [start, Math.max(start, end)];
}

/**
 * Split `path/to/file.ts:30` into its path and line parts.
 *
 * Line ranges (`file.ts:28-29`) are accepted and reported by their first line —
 * models cite ranges constantly, and reading the range as part of the filename
 * makes every such anchor look like a missing file.
 */
function splitAnchor(anchor: string): [string, string | undefined] {
  const match = /^(.*?):(\d+)(?:-\d+)?$/.exec(anchor);
  return match ? [match[1], match[2]] : [anchor, undefined];
}

function normalizeAnchors(anchors: string[] | undefined, root: string): string[] {
  if (!anchors || anchors.length === 0) return [];
  const out: string[] = [];

  for (const raw of anchors) {
    const trimmed = raw.trim().replace(/^[`'"]|[`'"]$/g, '');
    if (!trimmed) continue;
    const [filePath] = splitAnchor(trimmed);
    // Keep whatever line reference was given — a range is more informative than
    // the single line it starts on, and verification handles both.
    const suffix = trimmed.slice(filePath.length);
    // Store paths relative to the root so the memory survives a repo move.
    const relative = path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;
    if (relative.startsWith('..')) continue;
    const normalized = `${relative}${suffix}`;
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length >= MAX_ANCHORS_PER_FACT) break;
  }

  return out;
}

function mergeAnchors(existing: string[], added: string[]): string[] {
  const merged = [...existing];
  for (const anchor of added) {
    if (!merged.includes(anchor)) merged.push(anchor);
  }
  return merged.slice(0, MAX_ANCHORS_PER_FACT);
}

/** True when the two anchor lists point at the same file, whatever the line. */
function sharesAnchorFile(a: string[], b: string[]): boolean {
  const files = new Set(a.map((anchor) => splitAnchor(anchor)[0]));
  return b.some((anchor) => files.has(splitAnchor(anchor)[0]));
}

function readFile(file: string): string {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  } catch (err: any) {
    logger.warn(`[Memory] Could not read '${file}': ${err.message}`);
    return '';
  }
}
