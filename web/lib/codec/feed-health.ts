export const CODEC_FEED_STALE_AFTER_MS = 15_000;

export interface CodecFeedHealth {
  silenceMs: number;
  stale: boolean;
}

/** Alert only when the feed explicitly fails or stays silent for 15 seconds. */
export function codecFeedHealth(
  lastSignalAt: string,
  nowMs: number,
  explicitStale = false,
): CodecFeedHealth {
  const lastSignalMs = Date.parse(lastSignalAt);
  if (!Number.isFinite(lastSignalMs)) {
    return { silenceMs: CODEC_FEED_STALE_AFTER_MS, stale: true };
  }

  const silenceMs = Math.max(0, nowMs - lastSignalMs);
  return {
    silenceMs,
    stale: explicitStale || silenceMs >= CODEC_FEED_STALE_AFTER_MS,
  };
}
