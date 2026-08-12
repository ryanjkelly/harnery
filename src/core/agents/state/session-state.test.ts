import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "../events/consume.ts";
import { applySessionStateEvent, foldSessionState } from "./session-state.ts";

function event(
  event_type: string,
  ts: string,
  data: Record<string, unknown> = {},
  instance_id = "owner-a",
): CanonicalEvent {
  return {
    schema_version: 1,
    event_id: `${ts}-${event_type}`,
    event_type,
    ts,
    instance_id,
    session_id: instance_id,
    adapter: "codex",
    source: "test",
    data,
  };
}

describe("session state transition table", () => {
  test("tracks direct activity evidence and does not clear a wait on unrelated output", () => {
    const events = [
      event("session.start", "2026-08-12T10:00:00Z"),
      event("user_prompt.submit", "2026-08-12T10:01:00Z"),
      event("interaction.input_requested", "2026-08-12T10:02:00Z", {
        request_kind: "permission",
      }),
      event("tool.post_use", "2026-08-12T10:03:00Z"),
      event("command.output", "2026-08-12T10:04:00Z"),
    ];

    expect(foldSessionState(events)).toMatchObject({
      activity: "needs_input",
      activity_updated_at: "2026-08-12T10:02:00Z",
      activity_source: "interaction.input_requested",
      task_state: "active",
    });
  });

  test("new progress clears an input wait and turn.stop returns to idle", () => {
    const events = [
      event("user_prompt.submit", "2026-08-12T10:00:00Z"),
      event("interaction.input_requested", "2026-08-12T10:01:00Z"),
      event("command.start", "2026-08-12T10:02:00Z"),
      event("turn.stop", "2026-08-12T10:03:00Z"),
    ];

    expect(foldSessionState(events)).toMatchObject({
      activity: "idle",
      activity_updated_at: "2026-08-12T10:03:00Z",
      activity_source: "turn.stop",
    });
  });

  test("a command outside an evidenced open turn does not invent activity", () => {
    const fields = applySessionStateEvent(
      { activity: "idle", activity_updated_at: "2026-08-12T10:00:00Z" },
      event("command.start", "2026-08-12T10:01:00Z"),
    );
    expect(fields.activity).toBe("idle");
    expect(fields.activity_updated_at).toBe("2026-08-12T10:00:00Z");
  });

  test("folds lifecycle independently and clears obsolete blocker reasons", () => {
    const events = [
      event("state.task_state", "2026-08-12T10:00:00Z", {
        state: "blocked",
        reason: "waiting for a credential grant",
      }),
      event("user_prompt.submit", "2026-08-12T10:01:00Z"),
      event("state.task_state", "2026-08-12T10:02:00Z", { state: "active" }),
    ];

    expect(foldSessionState(events)).toEqual({
      activity: "working",
      activity_updated_at: "2026-08-12T10:01:00Z",
      activity_source: "user_prompt.submit",
      task_state: "active",
      task_state_updated_at: "2026-08-12T10:02:00Z",
    });
  });

  test("legacy and unsupported sessions stay unknown while lifecycle defaults active", () => {
    expect(foldSessionState([event("narration", "2026-08-12T10:00:00Z")])).toEqual({
      activity: "unknown",
      task_state: "active",
    });
  });

  test("filters a shared ledger by instance after the heartbeat is gone", () => {
    const events = [
      event("user_prompt.submit", "2026-08-12T10:00:00Z", {}, "owner-a"),
      event("turn.stop", "2026-08-12T10:00:30Z", {}, "owner-b"),
      event("interaction.input_requested", "2026-08-12T10:01:00Z", {}, "owner-a"),
    ];

    expect(foldSessionState(events, { instance_id: "owner-a" }).activity).toBe("needs_input");
  });

  test("orders replayed events by timestamp rather than append order", () => {
    const events = [
      event("turn.stop", "2026-08-12T10:02:00Z"),
      event("user_prompt.submit", "2026-08-12T10:01:00Z"),
    ];
    expect(foldSessionState(events).activity).toBe("idle");
  });
});
