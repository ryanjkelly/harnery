/**
 * Review-feed ordering: stakes × novelty. The human's review is calibration
 * sampling, not an approval queue, so the feed puts the entries that most repay
 * attention first and lets the tail be skimmed or skipped.
 *
 * Pure function so it's unit-tested (see decision-attention.test.ts) and reused
 * verbatim by the RSC page. Mirrors council-attention.ts's shape.
 */

import type { DecisionManifest } from "./decision-reader";

const STAKES_RANK: Record<string, number> = { high: 3, medium: 2, small: 1 };

/**
 * A decision is "novel" when no prior resolved precedent looks like it — here
 * approximated by whether its slug stem (the id minus the date + hash suffix)
 * has been seen among *other* decisions. A recurring question (stem seen
 * before) is lower-novelty: the human has effectively ruled on it already.
 */
function slugStem(id: string): string {
  // strip the trailing `-YYYY-MM-DD-hhhh`
  return id.replace(/-\d{4}-\d{2}-\d{2}-[0-9a-f]{4}$/, "");
}

export function reviewFeedScore(d: DecisionManifest, stemCounts: Map<string, number>): number {
  const stakes = STAKES_RANK[d.stakes] ?? 1;
  // tier 2 shouldn't generally be in the review feed (it's decided before
  // enactment), but if one lands here it outranks: it's the highest-touch kind.
  const tierWeight = d.tier === 2 ? 1.5 : d.tier === 1 ? 1 : 0.6;
  const seen = stemCounts.get(slugStem(d.decision_id)) ?? 1;
  const novelty = seen <= 1 ? 1 : 0.5; // recurring question => half weight
  return stakes * tierWeight * novelty;
}

/**
 * Sort a review feed newest-and-highest-stakes first. Ties (same score) break
 * on resolved-at (most recently resolved first) so fresh calls surface.
 */
export function sortReviewFeed(decisions: DecisionManifest[]): DecisionManifest[] {
  const stemCounts = new Map<string, number>();
  for (const d of decisions) {
    const stem = slugStem(d.decision_id);
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }
  return [...decisions].sort((a, b) => {
    const sa = reviewFeedScore(a, stemCounts);
    const sb = reviewFeedScore(b, stemCounts);
    if (sb !== sa) return sb - sa;
    const ra = a.resolution?.resolved_at ?? a.filed_at ?? "";
    const rb = b.resolution?.resolved_at ?? b.filed_at ?? "";
    return rb.localeCompare(ra);
  });
}
