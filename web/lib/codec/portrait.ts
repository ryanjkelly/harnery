/**
 * Portrait request recovery for a Codec card.
 *
 * A card that hit one failed portrait request used to hold the neutral letter
 * for the life of its mount: the failure flag never cleared when the pack,
 * version, or expression changed, and nothing retried. On a dashboard tab left
 * open for hours, one transient fetch failure (a dropped socket during a
 * server handover, a localhost forwarder hiccup) cost the portrait for good.
 *
 * The rules here are pure so they can be tested directly. A failure is keyed
 * to the exact source it happened for, so a new pack, version, or expression
 * starts clean. The same source retries on a short backoff a bounded number of
 * times, each with a cache-busting suffix, then holds the letter until the
 * source changes. A successful load clears everything.
 */

import type { CodecPanelScene } from "./contracts";

/** Backoff between retries of one failed source. Length bounds the attempts. */
export const PORTRAIT_RETRY_DELAYS_MS: readonly number[] = [2_000, 6_000, 18_000];

export interface PortraitFailure {
  /** The exact source that failed; a different source ignores this record. */
  source: string;
  /** Failed requests for this source so far, including the first. */
  attempts: number;
  /** `waiting` shows the letter until the backoff elapses; `retrying` requests again. */
  phase: "waiting" | "retrying";
}

/** The portrait URL for a bound pack, or null when the panel has no usable pack. */
export function portraitSource(panel: CodecPanelScene): string | null {
  if (panel.character.pack_id === "fallback-neutral") return null;
  return `/api/codec-pack/${panel.character.pack_id}/${panel.expression.value}?v=${panel.character.pack_version}`;
}

/** Record one more failed request for `source`; unrelated history is dropped. */
export function recordPortraitFailure(
  source: string,
  previous: PortraitFailure | null,
): PortraitFailure {
  const attempts = previous && previous.source === source ? previous.attempts + 1 : 1;
  return { source, attempts, phase: "waiting" };
}

/** Milliseconds until the next retry, or undefined when retries are exhausted. */
export function portraitRetryDelayMs(failure: PortraitFailure): number | undefined {
  return PORTRAIT_RETRY_DELAYS_MS[failure.attempts - 1];
}

/** Move a waiting failure to its retry; anything else is left as it is. */
export function beginPortraitRetry(failure: PortraitFailure | null): PortraitFailure | null {
  if (failure?.phase !== "waiting") return failure;
  return { ...failure, phase: "retrying" };
}

/**
 * The `src` to request now, or null to show the letter. A failure recorded
 * for a different source is ignored, which is what lets an expression or
 * pack-version change recover a card on its own.
 */
export function portraitImageSrc(
  source: string | null,
  failure: PortraitFailure | null,
): string | null {
  if (!source) return null;
  if (!failure || failure.source !== source) return source;
  if (failure.phase !== "retrying") return null;
  return `${source}&r=${failure.attempts}`;
}
