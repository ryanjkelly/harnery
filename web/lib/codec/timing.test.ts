import { describe, expect, test } from "bun:test";

import type { CodecSourceEvidence } from "./contracts";
import { projectCodecTimings } from "./timing";

const INSTANCE = "inst-timing";

function event(
  event_type: CodecSourceEvidence["event_type"],
  ts: string,
  extra: Partial<CodecSourceEvidence> = {},
): CodecSourceEvidence {
  return {
    schema_version: 2,
    event_id: `${event_type}-${ts}`,
    event_type,
    ts,
    instance_id: INSTANCE,
    ...extra,
  };
}

describe("projectCodecTimings", () => {
  test("partitions a session into working and idle time around explicit waits", () => {
    const timing = projectCodecTimings(
      [
        event("session.started", "2026-09-04T10:00:00.000Z"),
        event("turn.started", "2026-09-04T10:01:00.000Z", { turn_id: "turn-1" }),
        event("wait.started", "2026-09-04T10:03:00.000Z"),
        event("wait.ended", "2026-09-04T10:04:00.000Z"),
        event("turn.completed", "2026-09-04T10:06:00.000Z", { turn_id: "turn-1" }),
      ],
      "2026-09-04T10:10:00.000Z",
    ).get(INSTANCE);

    expect(timing?.value).toEqual({
      session_duration_ms: 600_000,
      last_turn_duration_ms: 300_000,
      working_duration_ms: 240_000,
      idle_duration_ms: 360_000,
      session_active: true,
      last_turn_active: false,
      current_bucket: "idle",
    });
  });

  test("keeps open session, turn, and working clocks active", () => {
    const timing = projectCodecTimings(
      [
        event("session.started", "2026-09-04T10:00:00.000Z"),
        event("turn.started", "2026-09-04T10:02:00.000Z"),
      ],
      "2026-09-04T10:05:00.000Z",
    ).get(INSTANCE);

    expect(timing?.value).toMatchObject({
      session_duration_ms: 300_000,
      last_turn_duration_ms: 180_000,
      working_duration_ms: 180_000,
      idle_duration_ms: 120_000,
      session_active: true,
      last_turn_active: true,
      current_bucket: "working",
    });
  });

  test("stops every clock at a terminal session event", () => {
    const timing = projectCodecTimings(
      [
        event("session.started", "2026-09-04T10:00:00.000Z"),
        event("turn.started", "2026-09-04T10:01:00.000Z"),
        event("session.ended", "2026-09-04T10:04:00.000Z"),
      ],
      "2026-09-04T10:10:00.000Z",
    ).get(INSTANCE);

    expect(timing?.value).toMatchObject({
      session_duration_ms: 240_000,
      last_turn_duration_ms: 180_000,
      working_duration_ms: 180_000,
      idle_duration_ms: 60_000,
      session_active: false,
      last_turn_active: false,
      current_bucket: "stopped",
    });
    expect(timing?.observed_at).toBe("2026-09-04T10:04:00.000Z");
  });

  test("omits timing when the bounded evidence has no session boundary", () => {
    const timings = projectCodecTimings(
      [event("turn.started", "2026-09-04T10:02:00.000Z")],
      "2026-09-04T10:05:00.000Z",
    );
    expect(timings.has(INSTANCE)).toBe(false);
  });
});
