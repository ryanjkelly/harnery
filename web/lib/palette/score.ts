/**
 * Match-quality scoring for command-palette items, kept beside the palette so
 * the ranking is unit-testable (lib/palette/score.test.ts).
 *
 * The palette filter (AND-of-token literal/fuzzy matches over label +
 * description + subtitle + keywords) decides WHETHER an item shows; this
 * scorer decides WHERE it ranks within its section. Tiers by where the query
 * matched:
 *
 *   exact label 100 > label prefix 85 > word boundary 78 > label substring 64
 *   > all tokens in label 52 > description 36 > keywords/subtitle only 12
 *
 * plus the item's `priority` hint clamped to 0–10. Adjacent tiers sit within
 * 10 of each other on purpose (85→78, 78→64 is wider): a high-priority item
 * (fresh, editorially valuable) can climb past a same-family neighbor, but
 * never past an exact match, and a keywords-only match can never outrank a
 * label match.
 */

export interface PaletteScorable {
  label: string;
  description?: string;
  priority?: number;
}

/**
 * Locate one ordered-subsequence token for VS Code-style match emphasis.
 * Prefer word/path boundaries and long adjacent runs while retaining the same
 * ordered-character acceptance semantics as the palette filter.
 */
function orderedSubsequenceIndices(haystack: string, needle: string): number[] | null {
  const indices: number[] = [];
  const latest: number[] = new Array(needle.length);
  let latestCursor = haystack.length;
  for (let i = needle.length - 1; i >= 0; i -= 1) {
    latestCursor = haystack.lastIndexOf(needle[i], latestCursor - 1);
    if (latestCursor < 0) return null;
    latest[i] = latestCursor;
  }

  let cursor = 0;

  for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let hayIndex = cursor; hayIndex <= latest[needleIndex]; hayIndex += 1) {
      if (haystack[hayIndex] !== needle[needleIndex]) continue;

      let adjacentRun = 1;
      while (
        needleIndex + adjacentRun < needle.length &&
        hayIndex + adjacentRun < haystack.length &&
        needle[needleIndex + adjacentRun] === haystack[hayIndex + adjacentRun]
      ) {
        adjacentRun += 1;
      }

      const atBoundary = hayIndex === 0 || /[\s/_.-]/.test(haystack[hayIndex - 1]);
      const score = adjacentRun * 10 + (atBoundary ? 5 : 0) - hayIndex / 10_000;
      if (score > bestScore) {
        bestIndex = hayIndex;
        bestScore = score;
      }
    }

    if (bestIndex < 0) return null;
    indices.push(bestIndex);
    cursor = bestIndex + 1;
  }

  return indices;
}

/**
 * Return the character positions that satisfy every query token, or `null`
 * when the text does not match. Literal substrings remain contiguous; fuzzy
 * fallback positions are optimized for readable path/name highlighting.
 */
export function paletteMatchIndices(haystack: string, tokens: string[]): number[] | null {
  const hay = haystack.toLowerCase();
  const matched = new Set<number>();

  for (const rawToken of tokens) {
    const token = rawToken.toLowerCase();
    if (!token) continue;

    const literalAt = hay.indexOf(token);
    if (literalAt >= 0) {
      for (let i = literalAt; i < literalAt + token.length; i += 1) matched.add(i);
      continue;
    }

    const fuzzy = orderedSubsequenceIndices(hay, token);
    if (!fuzzy) return null;
    for (const index of fuzzy) matched.add(index);
  }

  return [...matched].sort((a, b) => a - b);
}

/**
 * Match every query token against the searchable item text. Literal
 * substrings keep their existing behavior; otherwise characters may be
 * separated as long as they appear in order (VS Code-style fuzzy matching).
 */
export function matchesPaletteQuery(haystack: string, tokens: string[]): boolean {
  const hay = haystack.toLowerCase();
  return tokens.every((rawToken) => {
    const token = rawToken.toLowerCase();
    if (!token || hay.includes(token)) return true;
    let cursor = 0;
    for (const char of hay) {
      if (char === token[cursor]) cursor += 1;
      if (cursor === token.length) return true;
    }
    return false;
  });
}

/**
 * Build a scorer for one query. `q` must be lowercased + trimmed; `tokens`
 * are its whitespace-split parts. The returned function assumes the item
 * already PASSED the palette filter — anything that reaches it matched
 * somewhere, so the floor tier (12) means "matched via subtitle/keywords".
 */
export function makePaletteScorer(q: string, tokens: string[]): (it: PaletteScorable) => number {
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordRe = new RegExp(`\\b${esc}`);
  return (it: PaletteScorable): number => {
    const label = it.label.toLowerCase();
    let tier = 12; // matched via subtitle/keywords only
    if (label === q) tier = 100;
    else if (label.startsWith(q)) tier = 85;
    else if (wordRe.test(label)) tier = 78;
    else if (label.includes(q)) tier = 64;
    else if (tokens.every((t) => label.includes(t))) tier = 52;
    else if ((it.description ?? "").toLowerCase().includes(q)) tier = 36;
    return tier + Math.min(Math.max(it.priority ?? 0, 0), 10);
  };
}
