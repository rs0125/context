/** Name discovery only. Approximate names never establish identity, access or
 * mutation targets. Thresholds are global rules, not a stored-name alias list. */
export const OWNER_MATCH_MODES = ['auto', 'fuzzy', 'contains', 'exact'] as const;
export type OwnerMatchMode = typeof OWNER_MATCH_MODES[number];
export const OWNER_MATCH_POLICY = { version: 2, minimum_similarity: 0.75, max_edits: 2, minimum_fuzzy_characters: 5 } as const;
export const OWNER_LOOKUP_LIMIT = 20_000;

export function normalizeOwnerName(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[ .,'’()&/_–—-]+/gu, ' ').trim();
}

function nameWords(value: string) {
  // Titles and spacing vary in the inventory. Do not remove arbitrary words,
  // initials or company suffixes, nor transliterate or infer a person's name.
  return normalizeOwnerName(value).replace(/^(?:(?:mr|mrs|ms|dr) )+/, '').split(' ');
}

/** Banded optimal-string-alignment distance. Adjacent transpositions cost one
 * edit, like insertions, deletions and substitutions. Unicode code points are
 * preserved. Only a distance <= the small limit is meaningful to the caller. */
function editDistance(left: readonly string[], right: readonly string[], limit: number) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let beforePrevious: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = new Array<number>(right.length + 1).fill(limit + 1);
    current[0] = i;
    for (let j = Math.max(1, i - limit); j <= Math.min(right.length, i + limit); j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        current[j] = Math.min(current[j], beforePrevious[j - 2] + 1);
      }
    }
    beforePrevious = previous; previous = current;
  }
  return previous[right.length];
}

export type OwnerNameMatch = { name: string; kind: 'exact' | 'literal' | 'normalized' | 'fuzzy'; similarity: number; edits: number };

/** Compare complete contiguous word windows, joining spaces so recorded split
 * names and initials agree. Never approximate short substrings inside a word.
 * Missing required name parts do not match. */
function approximateName(query: readonly string[], name: string): OwnerNameMatch | null {
  if (query.length < OWNER_MATCH_POLICY.minimum_fuzzy_characters) return null;
  const words = nameWords(name);
  let best: OwnerNameMatch | null = null;
  for (let start = 0; start < words.length; start++) {
    const window: string[] = [];
    for (let end = start; end < words.length; end++) {
      window.push(...Array.from(words[end]));
      if (window.length > query.length + OWNER_MATCH_POLICY.max_edits) break;
      if (window.length < OWNER_MATCH_POLICY.minimum_fuzzy_characters) continue;
      const longest = Math.max(query.length, window.length);
      const limit = Math.min(OWNER_MATCH_POLICY.max_edits, Math.floor(longest * (1 - OWNER_MATCH_POLICY.minimum_similarity)));
      const edits = editDistance(query, window, limit);
      if (edits > limit) continue;
      const similarity = 1 - edits / longest;
      if (!best || similarity > best.similarity) best = { name, kind: 'fuzzy', similarity, edits };
    }
  }
  return best;
}

/** Names come from the currently scoped, sanitized warehouse rows. auto prefers
 * literal/spacing matches, avoiding unrelated near-names when the supplied
 * spelling already exists. Explicit fuzzy opts into the broader candidate set.
 * No cross-request vocabulary cache or inferred identity relationships. */
export function resolveOwnerNames(value: string, mode: OwnerMatchMode, names: readonly string[]) {
  const unique = [...new Set(names)];
  const literalQuery = normalizeOwnerName(value);
  const compactQuery = nameWords(value).join('');
  const queryPoints = Array.from(compactQuery);
  const matches = new Map<string, OwnerNameMatch>();
  for (const name of unique) {
    if (mode === 'exact') {
      if (name.normalize('NFKC').trim().toLowerCase() === value.normalize('NFKC').trim().toLowerCase()) {
        matches.set(name, { name, kind: 'exact', similarity: 1, edits: 0 });
      }
    } else if (normalizeOwnerName(name).includes(literalQuery)) {
      matches.set(name, { name, kind: 'literal', similarity: 1, edits: 0 });
    } else if (mode !== 'contains' && queryPoints.length >= OWNER_MATCH_POLICY.minimum_fuzzy_characters
      && nameWords(name).join('').includes(compactQuery)) {
      matches.set(name, { name, kind: 'normalized', similarity: 1, edits: 0 });
    }
  }
  const literalFound = matches.size > 0;
  if (mode === 'fuzzy' || (mode === 'auto' && !literalFound)) {
    for (const name of unique) if (!matches.has(name)) {
      const match = approximateName(queryPoints, name);
      if (match) matches.set(name, match);
    }
  }
  const strategy = !matches.size ? 'none' : mode === 'auto'
    ? literalFound ? 'literal_first' : 'fuzzy_fallback' : mode;
  return { matches, strategy,
    approximate_name_count: [...matches.values()].filter(match => match.kind === 'fuzzy').length };
}
