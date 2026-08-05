import { Entry } from './format.js';

export interface Scored<T> {
  item: T;
  score: number;
}

export interface RecallOptions {
  /** Maximum entries to return. */
  limit?: number;
  /** Entries scoring below this fraction of the top score are dropped. */
  relativeFloor?: number;
  /** Reference date for recency decay; defaults to now. Injectable for tests. */
  now?: Date;
}

// Standard BM25 constants: k1 controls term-frequency saturation, b the
// strength of the length normalization.
const K1 = 1.2;
const B = 0.75;

/**
 * Days after which an untouched entry scores half as much. Long enough that a
 * stable architectural fact survives a quiet month, short enough that a stale
 * note about last week's refactor stops crowding it out.
 */
const HALF_LIFE_DAYS = 45;
/**
 * Decay never drops below this. An old fact that is still true must stay
 * reachable — recency is a tiebreaker, not a death sentence.
 */
const DECAY_FLOOR = 0.35;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at', 'for',
  'and', 'or', 'but', 'it', 'its', 'this', 'that', 'these', 'those', 'with', 'as', 'by', 'from',
  'we', 'i', 'you', 'do', 'does', 'did', 'how', 'what', 'where', 'when', 'which', 'who', 'why',
  'في', 'من', 'على', 'عن', 'الى', 'إلى', 'هذا', 'هذه', 'التي', 'الذي', 'شنو', 'وين', 'شلون',
]);

/**
 * Split text into search terms.
 *
 * Code identifiers and paths are split apart as well as kept whole, so a query
 * for "auth" matches `AuthController.cs` and a query for the full filename
 * still scores highest.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];

  for (const raw of text.split(/[^A-Za-z0-9_./\-؀-ۿ]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower.length >= 2 && !STOPWORDS.has(lower)) tokens.push(lower);

    // Path and identifier segments.
    for (const part of raw.split(/[./\\_-]+/)) {
      if (!part) continue;

      // The whole segment, so a query for "AuthController" matches the file
      // name as well as its camelCase halves.
      const whole = part.toLowerCase();
      if (whole.length >= 2 && whole !== lower && !STOPWORDS.has(whole)) tokens.push(whole);

      // camelCase / PascalCase boundaries.
      for (const piece of part.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
        const token = piece.toLowerCase();
        if (token.length >= 2 && token !== lower && token !== whole && !STOPWORDS.has(token)) tokens.push(token);
      }
    }
  }

  return tokens;
}

/** The searchable text of an entry: its claim, its anchors and its kind. */
function documentOf(entry: Entry): string {
  return `${entry.text} ${entry.anchors.join(' ')} ${entry.kind}`;
}

/**
 * Rank entries against a query.
 *
 * Score = BM25 relevance × recency decay × quality. The three signals answer
 * different questions — is this about what I asked, is it still current, and
 * has it proved useful before — and collapsing them into one would let a
 * stale exact match outrank a current relevant one.
 */
export function recall(entries: Entry[], query: string, options: RecallOptions = {}): Scored<Entry>[] {
  const limit = options.limit ?? 8;
  const now = options.now ?? new Date();
  const queryTerms = [...new Set(tokenize(query))];
  if (entries.length === 0) return [];

  // An empty query is a request for the best of everything, not for nothing.
  if (queryTerms.length === 0) {
    return entries
      .map((entry) => ({ item: entry, score: quality(entry) * decay(entry, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  const documents = entries.map((entry) => tokenize(documentOf(entry)));
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;

  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const term of new Set(doc)) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  const total = entries.length;
  const scored: Scored<Entry>[] = [];

  for (let i = 0; i < entries.length; i++) {
    const doc = documents[i];
    const counts = new Map<string, number>();
    for (const term of doc) counts.set(term, (counts.get(term) || 0) + 1);

    let relevance = 0;
    for (const term of queryTerms) {
      const termFrequency = counts.get(term);
      if (!termFrequency) continue;
      const df = documentFrequency.get(term) || 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const norm = termFrequency * (K1 + 1);
      const denom = termFrequency + K1 * (1 - B + (B * doc.length) / averageLength);
      relevance += idf * (norm / denom);
    }

    if (relevance <= 0) continue;
    scored.push({ item: entries[i], score: relevance * decay(entries[i], now) * quality(entries[i]) });
  }

  scored.sort((a, b) => b.score - a.score);

  const floor = options.relativeFloor ?? 0.15;
  const top = scored[0]?.score ?? 0;
  return scored.filter((s) => s.score >= top * floor).slice(0, limit);
}

/** Exponential recency decay, floored so durable facts stay reachable. */
function decay(entry: Entry, now: Date): number {
  const parsed = Date.parse(entry.date);
  if (Number.isNaN(parsed)) return DECAY_FLOOR;
  const ageDays = Math.max(0, (now.getTime() - parsed) / 86_400_000);
  const value = Math.exp((-Math.LN2 * ageDays) / HALF_LIFE_DAYS);
  return Math.max(DECAY_FLOOR, value);
}

/** Confidence, nudged up by how often the entry has proved worth serving. */
function quality(entry: Entry): number {
  return entry.confidence * (1 + Math.log1p(entry.hits) * 0.15);
}
