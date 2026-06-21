/**
 * Round-triviality detection from contribution BODIES: the council-native
 * signal. The contribute convention has each member end their take with a
 * `<trivial>` or `<substantive>` status marker; two consecutive all-trivial
 * collected rounds = the council's exit criterion.
 *
 * This is the sibling of changelog-parser's matrix-based count, which only
 * works for councils whose target doc maintains a members + changelog table.
 * Councils without those tables (most of them) carry the signal in the
 * contribution files themselves; this module reads that.
 */

export type RoundBodies = {
  round: number;
  /** Contribution bodies for the round (collected rounds only; the caller
   * must exclude an in-progress open round, whose partial set would let the
   * criterion fire early). */
  bodies: string[];
};

/**
 * The marker that COUNTS is the last one in the body. Prompts and fold
 * records routinely *mention* both tags in prose ("end with `<substantive>`
 * if a defect surfaces"), but the status line sits at the end by convention.
 * Backticks around the tag don't matter (substring match); case-insensitive.
 * No marker at all → null (an untagged contribution never counts as trivial).
 */
export function lastStatusMarker(
  body: string,
): "trivial" | "substantive" | null {
  const lower = body.toLowerCase();
  const t = lower.lastIndexOf("<trivial>");
  const s = lower.lastIndexOf("<substantive>");
  if (t === -1 && s === -1) return null;
  return t > s ? "trivial" : "substantive";
}

/**
 * Consecutive all-trivial rounds, counted backwards from the most recent
 * populated round. Trailing rounds with zero contributions (force-advanced
 * empty) are skipped rather than streak-breaking; absence of contributions
 * is not evidence of divergence. A round counts only when it has at least
 * one contribution and EVERY contribution's last marker is `<trivial>`.
 */
export function countConsecutiveAllTrivialRoundsFromTags(
  rounds: RoundBodies[],
): number {
  const sorted = [...rounds].sort((a, b) => a.round - b.round);
  let i = sorted.length - 1;
  while (i >= 0 && sorted[i].bodies.length === 0) i--;
  let count = 0;
  for (; i >= 0; i--) {
    const bodies = sorted[i].bodies;
    if (bodies.length === 0) break;
    if (!bodies.every((b) => lastStatusMarker(b) === "trivial")) break;
    count++;
  }
  return count;
}
