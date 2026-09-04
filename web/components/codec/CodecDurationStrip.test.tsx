import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { CodecPanelScene } from "@/lib/codec/contracts";

import { CodecDurationStrip, formatCodecDuration, liveDurationValues } from "./CodecDurationStrip";

const TIMING: NonNullable<CodecPanelScene["timing"]> = {
  value: {
    session_duration_ms: 300_000,
    last_turn_duration_ms: 180_000,
    working_duration_ms: 180_000,
    idle_duration_ms: 120_000,
    session_active: true,
    last_turn_active: true,
    current_bucket: "working",
  },
  provenance: "event",
  confidence: "high",
  observed_at: "2026-09-04T10:05:00.000Z",
};

test("live duration values advance only the open clocks and current activity bucket", () => {
  expect(liveDurationValues(TIMING, Date.parse("2026-09-04T10:05:10.000Z"))).toEqual({
    session: 310_000,
    "last-turn": 190_000,
    working: 190_000,
    idle: 120_000,
  });
});

test("renders all four duration labels and precise short values", () => {
  const panel = { timing: TIMING } as CodecPanelScene;
  const html = renderToStaticMarkup(<CodecDurationStrip panel={panel} nowMs={null} />);
  expect(html).toContain("data-codec-durations");
  expect(html).toContain("session");
  expect(html).toContain("last turn");
  expect(html).toContain("working");
  expect(html).toContain("idle");
  expect(html).toContain("5m 0s");
});

test("formats longer durations without noisy seconds", () => {
  expect(formatCodecDuration(7_384_000)).toBe("2h 3m");
  expect(formatCodecDuration(93_600_000)).toBe("1d 2h");
});
