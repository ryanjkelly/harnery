import { describe, expect, test } from "bun:test";

import type { CodecPanelScene } from "./contracts";
import {
  beginPortraitRetry,
  PORTRAIT_RETRY_DELAYS_MS,
  type PortraitFailure,
  portraitImageSrc,
  portraitRetryDelayMs,
  portraitSource,
  recordPortraitFailure,
} from "./portrait";

function panel(
  expression: string,
  character: CodecPanelScene["character"] = { pack_id: "f19-s", pack_version: "2" },
): CodecPanelScene {
  return {
    character,
    expression: { value: expression },
  } as unknown as CodecPanelScene;
}

describe("portraitSource", () => {
  test("a bound pack yields its expression URL; the neutral pack yields no request", () => {
    expect(portraitSource(panel("focused"))).toBe("/api/codec-pack/f19-s/focused?v=2");
    expect(
      portraitSource(panel("focused", { pack_id: "fallback-neutral", pack_version: "0" })),
    ).toBe(null);
  });
});

describe("portrait failure recovery", () => {
  const focused = portraitSource(panel("focused")) as string;
  const investigating = portraitSource(panel("investigating")) as string;

  test("a failure suppresses only the source that failed", () => {
    // Mount, first request fails: the letter shows while the retry waits.
    const failed = recordPortraitFailure(focused, null);
    expect(failed).toEqual({ source: focused, attempts: 1, phase: "waiting" });
    expect(portraitImageSrc(focused, failed)).toBe(null);

    // The expression changes: the new source renders again immediately, with
    // no history carried over. This is the recovery the old latch never had.
    expect(portraitImageSrc(investigating, failed)).toBe(investigating);
    expect(recordPortraitFailure(investigating, failed).attempts).toBe(1);

    // A pack-version change is a new source too.
    const upgraded = portraitSource(panel("focused", { pack_id: "f19-s", pack_version: "3" }));
    expect(portraitImageSrc(upgraded, failed)).toBe(upgraded);
  });

  test("the same source retries on a bounded backoff, then holds the letter", () => {
    let failure: PortraitFailure | null = null;
    const delays: number[] = [];
    for (let attempt = 1; attempt <= PORTRAIT_RETRY_DELAYS_MS.length; attempt += 1) {
      failure = recordPortraitFailure(focused, failure);
      expect(failure.attempts).toBe(attempt);
      const delay = portraitRetryDelayMs(failure);
      if (delay === undefined) throw new Error("retry expected");
      delays.push(delay);
      // Waiting shows the letter; the elapsed backoff requests again with a
      // cache-busting suffix so a cached failure is not replayed.
      expect(portraitImageSrc(focused, failure)).toBe(null);
      failure = beginPortraitRetry(failure);
      expect(portraitImageSrc(focused, failure)).toBe(`${focused}&r=${attempt}`);
    }
    expect(delays).toEqual([...PORTRAIT_RETRY_DELAYS_MS]);

    // One more failure exhausts the budget: no timer, letter until the source changes.
    failure = recordPortraitFailure(focused, failure);
    expect(portraitRetryDelayMs(failure)).toBeUndefined();
    expect(portraitImageSrc(focused, failure)).toBe(null);
    expect(portraitImageSrc(investigating, failure)).toBe(investigating);
  });

  test("beginPortraitRetry leaves non-waiting states alone", () => {
    expect(beginPortraitRetry(null)).toBe(null);
    const retrying: PortraitFailure = { source: focused, attempts: 1, phase: "retrying" };
    expect(beginPortraitRetry(retrying)).toBe(retrying);
  });

  test("no source means no request regardless of history", () => {
    const failed = recordPortraitFailure(focused, null);
    expect(portraitImageSrc(null, failed)).toBe(null);
  });
});
