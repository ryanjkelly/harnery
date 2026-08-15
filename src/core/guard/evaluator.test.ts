import { describe, expect, test } from "bun:test";
import { DEFAULT_RUN_QUALITY_CONFIG } from "./config.ts";
import { evaluateRunQuality } from "./evaluator.ts";
import type {
  EvaluateRunQualityInput,
  RunQualityEvidenceEvent,
  RunQualitySnapshot,
} from "./types.ts";

const config = {
  ...DEFAULT_RUN_QUALITY_CONFIG,
  mode: "shadow" as const,
  evaluation_interval_seconds: 10,
  thresholds: {
    ...DEFAULT_RUN_QUALITY_CONFIG.thresholds,
    repeated_tool_calls: 2,
    consecutive_failures: 2,
    context_growth_per_minute: 100,
    no_progress_evaluations: 2,
  },
};

describe("evaluateRunQuality", () => {
  test("detects consecutive exact repetition but not an alternating A/B loop", () => {
    const repeated = evaluateRunQuality(
      input([
        event("01", "tool_call", { input_hash: "same" }),
        event("02", "tool_call", { input_hash: "same" }),
      ]),
    );
    expect(repeated.status).toBe("attention");
    expect(signal(repeated, "repeated_tool_calls")).toMatchObject({ state: "active", count: 2 });

    const alternating = evaluateRunQuality(
      input([
        event("01", "tool_call", { input_hash: "A" }),
        event("02", "tool_call", { input_hash: "B" }),
        event("03", "tool_call", { input_hash: "A" }),
        event("04", "tool_call", { input_hash: "B" }),
      ]),
    );
    expect(signal(alternating, "repeated_tool_calls")).toMatchObject({
      state: "inactive",
      count: 1,
    });
  });

  test("marks legacy hashless repetition unknown and never hashes a clamp", () => {
    const snapshot = evaluateRunQuality(
      input([event("01", "tool_call"), event("02", "tool_call")]),
    );
    expect(signal(snapshot, "repeated_tool_calls").state).toBe("unknown");
  });

  test("tracks a stable target independently from exact input repetition", () => {
    const snapshot = evaluateRunQuality(
      input([
        event("01", "tool_call", { input_hash: "input-a", target_hash: "target" }),
        event("02", "tool_call", { input_hash: "input-b", target_hash: "target" }),
      ]),
    );
    expect(signal(snapshot, "repeated_tool_calls").state).toBe("inactive");
    expect(signal(snapshot, "target_stagnation")).toMatchObject({ state: "active", count: 2 });
  });

  test("holds a failure streak across missing outcomes and resets on success", () => {
    const held = evaluateRunQuality(
      input([
        event("01", "tool_failure"),
        event("02", "tool_call", { input_hash: "x" }),
        event("03", "tool_failure"),
      ]),
    );
    expect(signal(held, "consecutive_failures")).toMatchObject({ state: "active", count: 2 });
    const reset = evaluateRunQuality(input([event("04", "tool_success")], held));
    expect(signal(reset, "consecutive_failures").count).toBe(0);
  });

  test("uses only adapter-attested exact or reported context samples", () => {
    const attested = evaluateRunQuality(
      input([
        event("01", "context_sample", {
          used_tokens: 100,
          confidence: "reported",
          telemetry_source: "hook",
        }),
        event("02", "context_sample", {
          used_tokens: 250,
          confidence: "reported",
          telemetry_source: "hook",
          ts: "2026-08-15T00:01:00.000Z",
        }),
      ]),
    );
    expect(signal(attested, "context_growth").state).toBe("active");

    const estimated = evaluateRunQuality(
      input([
        event("01", "context_sample", {
          used_tokens: 100,
          confidence: "estimated",
          telemetry_source: "estimate",
        }),
      ]),
    );
    expect(signal(estimated, "context_growth").state).toBe("unknown");
  });

  test("requires a deadline epoch before corroborated no-progress activates", () => {
    const first = evaluateRunQuality(
      input([
        event("01", "tool_call", { input_hash: "same" }),
        event("02", "tool_call", { input_hash: "same" }),
        event("03", "tool_failure"),
        event("04", "tool_failure"),
      ]),
    );
    expect(signal(first, "no_progress").reason_code).toBe("deadline_epoch_required");
    const deadline = evaluateRunQuality(input([], first, "2026-08-15T00:00:11.000Z"));
    expect(deadline.epoch).toBe("deadline");
    expect(signal(deadline, "no_progress")).toMatchObject({ state: "active", count: 2 });
  });

  test("fresh waits suppress timer-derived no-progress but keep repetition visible", () => {
    const first = evaluateRunQuality(
      input([
        event("01", "tool_call", { input_hash: "same" }),
        event("02", "tool_call", { input_hash: "same" }),
      ]),
    );
    const nextInput = input([], first, "2026-08-15T00:00:11.000Z");
    nextInput.role_wait = {
      role: "reviewer",
      wait_kind: "approval",
      source: "workflow_approval",
      observed_at: nextInput.now,
      fresh: true,
    };
    const waited = evaluateRunQuality(nextInput);
    expect(waited.epoch).toBe("read");
    expect(signal(waited, "no_progress").state).toBe("suppressed");
    expect(signal(waited, "repeated_tool_calls").state).toBe("active");
  });

  test("compaction grace has a hard deadline and state survives snapshot TTL", () => {
    const first = evaluateRunQuality(
      input([
        event("01", "compaction_started"),
        event("02", "tool_call", { input_hash: "same" }),
        event("03", "tool_call", { input_hash: "same" }),
      ]),
    );
    expect(signal(first, "no_progress").state).toBe("suppressed");
    const afterGrace = evaluateRunQuality(input([], first, "2026-08-15T00:06:00.000Z"));
    expect(afterGrace.state.repeated_count).toBe(2);
    expect(signal(afterGrace, "compaction_grace").state).toBe("inactive");
  });

  test("config changes retain the watermark but reset arms and emit the reason", () => {
    const first = evaluateRunQuality(
      input([event("01", "tool_failure"), event("02", "tool_failure")]),
    );
    const changed = input([], first, "2026-08-15T00:00:11.000Z");
    changed.config_digest = "changed";
    const snapshot = evaluateRunQuality(changed);
    expect(snapshot.reason).toBe("config_changed");
    expect(snapshot.evidence.last_event_id).toBe(first.evidence.last_event_id);
    expect(snapshot.state.failure_streak).toBe(0);
  });

  test("insufficient or truncated history remains unknown even with a partial-window signal", () => {
    const missing = input([
      event("01", "tool_call", { input_hash: "same" }),
      event("02", "tool_call", { input_hash: "same" }),
    ]);
    missing.sufficient_history = false;
    missing.evidence.truncated = true;
    expect(evaluateRunQuality(missing).status).toBe("unknown");
  });
});

function input(
  events: RunQualityEvidenceEvent[],
  previous?: RunQualitySnapshot,
  now = "2026-08-15T00:00:00.000Z",
): EvaluateRunQualityInput {
  return {
    instance_id: "instance-a",
    session_id: "session-a",
    session_generation: "generation-a",
    adapter: "claude-code",
    now,
    config,
    config_digest: "config-a",
    events,
    previous,
    role_wait: {
      role: "session",
      wait_kind: "none",
      source: "heartbeat",
      observed_at: now,
      fresh: true,
    },
    evidence: {
      first_event_id: previous?.evidence.first_event_id ?? events[0]?.event_id,
      last_event_id: events.at(-1)?.event_id ?? previous?.evidence.last_event_id,
      window_started_at: previous?.evidence.window_started_at ?? events[0]?.ts,
      window_ended_at: events.at(-1)?.ts ?? previous?.evidence.window_ended_at,
      segment: ".harnery/events.ndjson",
      truncated: false,
    },
    sufficient_history: true,
    live: true,
  };
}

function event(
  eventId: string,
  kind: RunQualityEvidenceEvent["kind"],
  extra: Partial<RunQualityEvidenceEvent> = {},
): RunQualityEvidenceEvent {
  return { event_id: eventId, ts: "2026-08-15T00:00:00.000Z", kind, ...extra };
}

function signal(snapshot: RunQualitySnapshot, id: RunQualitySnapshot["signals"][number]["id"]) {
  return snapshot.signals.find((candidate) => candidate.id === id)!;
}
