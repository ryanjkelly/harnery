import { describe, expect, test } from "bun:test";
import { CODEC_FEED_STALE_AFTER_MS, codecFeedHealth } from "./feed-health";

describe("Codec feed health", () => {
  const lastSignalAt = "2026-08-24T12:00:00.000Z";
  const lastSignalMs = Date.parse(lastSignalAt);

  test("stays quiet until exactly 15 seconds without an update", () => {
    expect(codecFeedHealth(lastSignalAt, lastSignalMs + CODEC_FEED_STALE_AFTER_MS - 1)).toEqual({
      silenceMs: CODEC_FEED_STALE_AFTER_MS - 1,
      stale: false,
    });
    expect(codecFeedHealth(lastSignalAt, lastSignalMs + CODEC_FEED_STALE_AFTER_MS)).toEqual({
      silenceMs: CODEC_FEED_STALE_AFTER_MS,
      stale: true,
    });
  });

  test("alerts immediately when the stream explicitly reports stale", () => {
    expect(codecFeedHealth(lastSignalAt, lastSignalMs + 1_000, true)).toEqual({
      silenceMs: 1_000,
      stale: true,
    });
  });

  test("fails stale for an invalid timestamp and clamps future clock skew", () => {
    expect(codecFeedHealth("not-a-date", lastSignalMs)).toEqual({
      silenceMs: CODEC_FEED_STALE_AFTER_MS,
      stale: true,
    });
    expect(codecFeedHealth(lastSignalAt, lastSignalMs - 1_000)).toEqual({
      silenceMs: 0,
      stale: false,
    });
  });
});
