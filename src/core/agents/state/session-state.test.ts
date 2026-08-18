import { describe, expect, test } from "bun:test";
import {
  applySessionStateEvent,
  foldSessionState,
  type SessionStateEvidenceEvent,
} from "./session-state.ts";

function event(
  event_type: SessionStateEvidenceEvent["event_type"],
  ts: string,
  payload: Record<string, unknown> = {},
  instance_id = "owner-a",
): SessionStateEvidenceEvent {
  return {
    event_type,
    ts,
    instance_id,
    session_id: instance_id,
    payload,
  };
}

describe("session state transition table", () => {
  test("tracks direct activity evidence and does not clear a wait on unrelated output", () => {
    const events = [
      event("session.started", "2026-08-12T10:00:00Z"),
      event("turn.started", "2026-08-12T10:01:00Z"),
      event("interaction.wait_started", "2026-08-12T10:02:00Z", {
        kind: "approval",
      }),
      event("tool.completed", "2026-08-12T10:03:00Z"),
      event("health.observed", "2026-08-12T10:04:00Z"),
    ];

    expect(foldSessionState(events)).toMatchObject({
      activity: "needs_input",
      activity_updated_at: "2026-08-12T10:02:00Z",
      activity_source: "interaction.wait_started",
      task_state: "active",
    });
  });

  test("new progress clears an input wait and turn.completed returns to idle", () => {
    const events = [
      event("turn.started", "2026-08-12T10:00:00Z"),
      event("interaction.wait_started", "2026-08-12T10:01:00Z"),
      event("command.started", "2026-08-12T10:02:00Z"),
      event("turn.completed", "2026-08-12T10:03:00Z"),
    ];

    expect(foldSessionState(events)).toMatchObject({
      activity: "idle",
      activity_updated_at: "2026-08-12T10:03:00Z",
      activity_source: "turn.completed",
    });
  });

  test("a command outside an evidenced open turn does not invent activity", () => {
    const fields = applySessionStateEvent(
      { activity: "idle", activity_updated_at: "2026-08-12T10:00:00Z" },
      event("command.started", "2026-08-12T10:01:00Z"),
    );
    expect(fields.activity).toBe("idle");
    expect(fields.activity_updated_at).toBe("2026-08-12T10:00:00Z");
  });

  test("folds lifecycle independently and clears obsolete blocker reasons", () => {
    const events = [
      event("coord.lifecycle_changed", "2026-08-12T10:00:00Z", {
        new_state: "blocked",
        reason: "waiting for a credential grant",
      }),
      event("turn.started", "2026-08-12T10:01:00Z"),
      event("coord.lifecycle_changed", "2026-08-12T10:02:00Z", {
        new_state: "active",
      }),
    ];

    expect(foldSessionState(events)).toEqual({
      activity: "working",
      activity_updated_at: "2026-08-12T10:01:00Z",
      activity_source: "turn.started",
      task_state: "active",
      task_state_updated_at: "2026-08-12T10:02:00Z",
    });
  });

  test("incidental V2 evidence stays unknown while lifecycle defaults active", () => {
    expect(foldSessionState([event("progress.observed", "2026-08-12T10:00:00Z")])).toEqual({
      activity: "unknown",
      task_state: "active",
    });
  });

  test("filters a shared ledger by instance after the heartbeat is gone", () => {
    const events = [
      event("turn.started", "2026-08-12T10:00:00Z", {}, "owner-a"),
      event("turn.completed", "2026-08-12T10:00:30Z", {}, "owner-b"),
      event("interaction.wait_started", "2026-08-12T10:01:00Z", {}, "owner-a"),
    ];

    expect(foldSessionState(events, { instance_id: "owner-a" }).activity).toBe("needs_input");
  });

  test("orders replayed events by timestamp rather than append order", () => {
    const events = [
      event("turn.completed", "2026-08-12T10:02:00Z"),
      event("turn.started", "2026-08-12T10:01:00Z"),
    ];
    expect(foldSessionState(events).activity).toBe("idle");
  });
});
