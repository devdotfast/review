import fuzzysort from "fuzzysort";

/* Below this score the query only matched as scattered letters — "dev" landing
   on the d, e and v of "Speed up Review Desktop". Those hits are noise, and a
   plain subsequence matcher cannot tell them from real ones. */
const SCORE_THRESHOLD = 0.5;

/**
 * The single fuzzy matcher for this package. Each label is scored on its own,
 * never joined: a match across a join could pair a letter from one label with
 * a letter from the next and keep an item that shows neither word.
 */
function bestScore(needle: string, labels: readonly string[]): number {
  let best = 0;
  for (const label of labels) {
    const score = fuzzysort.single(needle, label)?.score ?? 0;
    if (score > best) best = score;
  }
  return best;
}

/** True when the query hits any label. An empty query matches everything. */
export function fuzzyMatches(query: string, ...labels: string[]): boolean {
  const needle = query.trim();
  if (!needle) return true;
  return bestScore(needle, labels) >= SCORE_THRESHOLD;
}

export interface FuzzySegment {
  text: string;
  matched: boolean;
}

/**
 * The label split into matched and unmatched runs, in order, for callers that
 * want to mark the hit. Returns the whole label as one unmatched segment when
 * the label itself did not match — a review found by its worktree name shows a
 * plain title, not a scatter of marked letters.
 *
 * Segments, not markup: this module must not depend on a UI framework.
 */
export function fuzzySegments(query: string, label: string): FuzzySegment[] {
  const whole = [{ text: label, matched: false }];
  const needle = query.trim();
  if (!needle) return whole;
  const result = fuzzysort.single(needle, label);
  if (!result || result.score < SCORE_THRESHOLD) return whole;

  // Indexed by code unit, the way fuzzysort reports its matches.
  const hit = new Set<number>(result.indexes);
  const segments: FuzzySegment[] = [];
  for (let index = 0; index < label.length; index++) {
    const matched = hit.has(index);
    const last = segments.at(-1);
    if (last && last.matched === matched) {
      last.text += label[index];
    } else {
      segments.push({ text: label[index], matched });
    }
  }
  return segments;
}

/**
 * The items whose labels hit the query, best match first. An empty query keeps
 * every item in its original order.
 */
export function fuzzyRank<T>(
  query: string,
  items: readonly T[],
  labelsOf: (item: T) => string[],
): T[] {
  const needle = query.trim();
  if (!needle) return [...items];
  return items
    .map((item) => ({ item, score: bestScore(needle, labelsOf(item)) }))
    .filter((hit) => hit.score >= SCORE_THRESHOLD)
    .sort((left, right) => right.score - left.score)
    .map((hit) => hit.item);
}
