/**
 * Plain-text memory format.
 *
 * Memory is stored as markdown, not JSON, because the agent reads it back on
 * every run and JSON spends 5-8x the tokens on braces, quotes and indentation
 * for the same content. One entry is one line:
 *
 *   - [a3f] Kestrel binds 0.0.0.0:6777 @server/src/Program.cs:30 #config x4 c0.90 2026-08-05
 *
 * Trailing metadata is parsed right-to-left so the free-form text may itself
 * contain '@' or '#' without confusing the parser.
 */

export type EntryKind =
  | 'stack'
  | 'config'
  | 'entrypoint'
  | 'contract'
  | 'convention'
  | 'gotcha'
  | 'security'
  | 'decision'
  | 'rule';

export const ENTRY_KINDS: EntryKind[] = [
  'stack',
  'config',
  'entrypoint',
  'contract',
  'convention',
  'gotcha',
  'security',
  'decision',
  'rule',
];

export interface Entry {
  /** Short stable id, unique within its file. */
  id: string;
  /** The claim itself, in plain prose. */
  text: string;
  /** `path:line` pointers backing the claim. */
  anchors: string[];
  kind: EntryKind;
  /** How many times this entry has been retrieved and used. */
  hits: number;
  /** 0..1 — drops when an anchor stops resolving, rises on re-observation. */
  confidence: number;
  /** ISO date (YYYY-MM-DD) this entry was last written or verified. */
  date: string;
  /**
   * Short hash of the code the anchors point at, taken when the fact was
   * recorded. Anchors alone only prove a file still exists — this proves the
   * lines behind the claim are the ones it was made about.
   */
  fingerprint?: string;
  /**
   * The anchored code changed after this fact was written. The claim may still
   * be true, but nothing has confirmed it since, so it is served with a warning
   * rather than as established fact.
   */
  stale?: boolean;
  /** Set when a newer entry replaced this one; only used in the archive. */
  supersededBy?: string;
}

const ENTRY_LINE = /^\s*[-*]\s+\[([a-z0-9]{2,8})\]\s+(.*)$/i;

/** Metadata tokens, matched only at the end of the line. */
const TRAILING_DATE = /\s+(\d{4}-\d{2}-\d{2})\s*$/;
const TRAILING_CONF = /\s+c(\d(?:\.\d{1,2})?)\s*$/;
const TRAILING_HITS = /\s+x(\d{1,6})\s*$/;
const TRAILING_KIND = new RegExp(`\\s+#(${ENTRY_KINDS.join('|')})\\s*$`);
const TRAILING_ANCHORS = /\s+@(\S+)\s*$/;
const TRAILING_SUPERSEDED = /\s+>([a-z0-9]{2,8})\s*$/i;
const TRAILING_STALE = /\s+!\s*$/;
const TRAILING_FINGERPRINT = /\s+~([a-f0-9]{4,16})\s*$/i;

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function formatEntry(entry: Entry): string {
  const parts = [`- [${entry.id}] ${entry.text.trim()}`];
  if (entry.anchors.length > 0) parts.push(`@${entry.anchors.join(',')}`);
  parts.push(`#${entry.kind}`);
  if (entry.hits > 0) parts.push(`x${entry.hits}`);
  parts.push(`c${entry.confidence.toFixed(2)}`);
  parts.push(entry.date);
  if (entry.fingerprint) parts.push(`~${entry.fingerprint}`);
  if (entry.stale) parts.push('!');
  if (entry.supersededBy) parts.push(`>${entry.supersededBy}`);
  return parts.join(' ');
}

/**
 * Parse one entry line. Metadata is stripped from the right in the same order
 * `formatEntry` appends it; whatever survives on the left is the text. Missing
 * tokens fall back to defaults so a hand-edited file still loads.
 */
export function parseEntry(line: string): Entry | undefined {
  const head = ENTRY_LINE.exec(line);
  if (!head) return undefined;

  const id = head[1];
  let rest = head[2];

  let supersededBy: string | undefined;
  const sup = TRAILING_SUPERSEDED.exec(rest);
  if (sup) {
    supersededBy = sup[1];
    rest = rest.slice(0, sup.index);
  }

  let stale = false;
  const staleMatch = TRAILING_STALE.exec(rest);
  if (staleMatch) {
    stale = true;
    rest = rest.slice(0, staleMatch.index);
  }

  let fingerprint: string | undefined;
  const fingerprintMatch = TRAILING_FINGERPRINT.exec(rest);
  if (fingerprintMatch) {
    fingerprint = fingerprintMatch[1].toLowerCase();
    rest = rest.slice(0, fingerprintMatch.index);
  }

  let date = todayIso();
  const dateMatch = TRAILING_DATE.exec(rest);
  if (dateMatch) {
    date = dateMatch[1];
    rest = rest.slice(0, dateMatch.index);
  }

  let confidence = 0.6;
  const confMatch = TRAILING_CONF.exec(rest);
  if (confMatch) {
    confidence = clamp01(parseFloat(confMatch[1]));
    rest = rest.slice(0, confMatch.index);
  }

  let hits = 0;
  const hitsMatch = TRAILING_HITS.exec(rest);
  if (hitsMatch) {
    hits = parseInt(hitsMatch[1], 10);
    rest = rest.slice(0, hitsMatch.index);
  }

  let kind: EntryKind = 'gotcha';
  const kindMatch = TRAILING_KIND.exec(rest);
  if (kindMatch) {
    kind = kindMatch[1] as EntryKind;
    rest = rest.slice(0, kindMatch.index);
  }

  let anchors: string[] = [];
  const anchorMatch = TRAILING_ANCHORS.exec(rest);
  if (anchorMatch) {
    anchors = anchorMatch[1].split(',').map((a) => a.trim()).filter(Boolean);
    rest = rest.slice(0, anchorMatch.index);
  }

  const text = rest.trim();
  if (!text) return undefined;

  return {
    id,
    text,
    anchors,
    kind,
    hits,
    confidence,
    date,
    ...(fingerprint ? { fingerprint } : {}),
    ...(stale ? { stale } : {}),
    supersededBy,
  };
}

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// --------------------------------------------------------------- sections

/**
 * Read a `## Heading` section out of a markdown document. Returns the lines
 * between the heading and the next heading of the same or higher level.
 */
export function readSection(doc: string, heading: string): string[] {
  const lines = doc.split('\n');
  const wanted = heading.trim().toLowerCase();
  let inside = false;
  const out: string[] = [];

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      const title = match[2].trim().toLowerCase();
      if (inside) break;
      if (title === wanted) {
        inside = true;
        continue;
      }
      continue;
    }
    if (inside) out.push(line);
  }

  return out;
}

/** Replace a `## Heading` section's body, appending the section if absent. */
export function writeSection(doc: string, heading: string, body: string): string {
  const lines = doc.split('\n');
  const wanted = heading.trim().toLowerCase();
  const out: string[] = [];
  let i = 0;
  let replaced = false;

  while (i < lines.length) {
    const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (match && match[2].trim().toLowerCase() === wanted) {
      out.push(lines[i]);
      i++;
      // Skip the old body.
      while (i < lines.length && !/^#{1,6}\s+/.test(lines[i])) i++;
      out.push(body.replace(/\s+$/, ''), '');
      replaced = true;
      continue;
    }
    out.push(lines[i]);
    i++;
  }

  if (!replaced) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(`## ${heading}`, body.replace(/\s+$/, ''), '');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Every entry line in a document, in file order. */
export function parseEntries(doc: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of doc.split('\n')) {
    const entry = parseEntry(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ------------------------------------------------------------------- ids

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Short id, unique against `taken`. Deterministic length keeps lines tidy. */
export function makeId(taken: Set<string>): string {
  for (let length = 3; length <= 6; length++) {
    for (let attempt = 0; attempt < 200; attempt++) {
      let id = '';
      for (let i = 0; i < length; i++) {
        id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
      }
      if (!taken.has(id)) return id;
    }
  }
  return `x${Date.now().toString(36)}`;
}
