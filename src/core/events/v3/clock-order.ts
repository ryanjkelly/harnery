/**
 * Producer-side wall-clock ordering for V3 events.
 *
 * The canonical reader fails closed on an unmarked wall-clock regression
 * (`wall_clock_regression_unmarked`). Once one row carries an `observed_at`
 * earlier than the previous row on the same `clock_id`, the whole authority
 * stops validating and no later generation can be minted, so every live agent
 * disappears from coordination at once.
 *
 * Producers already drop a regressing `monotonic_ns`. Wall clock had no
 * equivalent, so two events stamped microseconds apart inside one hook
 * invocation could darken the ledger: on 2026-08-19 a `tool.completed`
 * observed at `19:39:36.078Z` was followed by the `turn.completed` it caused,
 * observed at `19:39:36.077Z`.
 *
 * Rewriting the timestamp is not an option — a producer must not manufacture
 * history — so the row is marked instead. `skew: "regressed"` is the contract's
 * own vocabulary for this, and the reader accepts a marked regression.
 */

/** The slice of a V3 event this rule reads and marks. */
interface ClockOrderedEventV3 {
  time: { observed_at: string; skew: "normal" | "regressed" | "unknown" };
}

/**
 * Mark `event` as regressed when its `observed_at` precedes the last one this
 * producer stamped on the same clock. Unparseable or absent evidence leaves the
 * event untouched: an unmarked row that never regressed stays unmarked.
 */
export function markObservedClockRegressionV3(
  event: ClockOrderedEventV3,
  lastObservedAt: string | undefined,
): void {
  if (!lastObservedAt) return;
  const observed = Date.parse(event.time.observed_at);
  const prior = Date.parse(lastObservedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(prior)) return;
  if (observed >= prior) return;
  event.time.skew = "regressed";
}
