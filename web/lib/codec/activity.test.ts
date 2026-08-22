import { describe, expect, test } from "bun:test";
import { projectActivityChannels } from "./activity";
import type { CodecComparableFingerprint, CodecSourceEvidence } from "./contracts";

const NOW = "2026-08-21T15:05:00.000Z";

let sequence = 0;
function at(secondsAgo: number): string {
  return new Date(Date.parse(NOW) - secondsAgo * 1000).toISOString();
}

function event(overrides: Partial<CodecSourceEvidence>): CodecSourceEvidence {
  sequence += 1;
  return {
    schema_version: 2,
    event_id: `evt-${sequence}`,
    event_type: "coord.status_observed",
    ts: at(30),
    instance_id: "inst-a",
    ...overrides,
  };
}

function fingerprint(seed: string): CodecComparableFingerprint {
  return {
    digest: `sha256:${seed.padEnd(64, "a").slice(0, 64)}`,
    scope: "generation",
    key_epoch: "pep-test",
  };
}

describe("projectActivityChannels", () => {
  test("uses the typed wait kind for the operation label", () => {
    const channels = projectActivityChannels(
      [
        event({
          event_type: "wait.started",
          wait_id: "wait-dependency",
          wait_kind: "dependency",
          category: "coordinate",
        }),
      ],
      NOW,
    ).get("inst-a");

    expect(channels?.operation?.value).toMatchObject({
      label: "Waiting on a dependency",
      state: "active",
    });
  });

  test("shows the newest open leaf and a short output-flow pulse", () => {
    const channels = projectActivityChannels(
      [
        event({
          event_type: "tool.requested",
          ts: at(40),
          span_id: "span-tool",
          tool_namespace: "functions",
          tool_name: "exec_command",
          category: "diagnostic",
          operation_fingerprint: fingerprint("tool"),
        }),
        event({
          event_type: "command.started",
          ts: at(30),
          span_id: "span-command",
          parent_span_id: "span-tool",
          tool_namespace: "command",
          tool_name: "rg",
          category: "diagnostic",
          operation_fingerprint: fingerprint("command"),
        }),
        event({
          event_type: "command.output_observed",
          ts: at(2),
          span_id: "span-command",
          output_stream: "stdout",
          output_bytes: 48,
        }),
      ],
      NOW,
    ).get("inst-a");

    expect(channels?.operation?.value).toMatchObject({
      label: "Running rg",
      state: "output-flow",
      elapsed_ms: 30_000,
    });
    expect(channels?.operation?.evidence_event_ids).toHaveLength(2);
  });

  test("terminal span evidence closes the operation", () => {
    const channels = projectActivityChannels(
      [
        event({
          event_type: "tool.requested",
          span_id: "span-1",
          tool_name: "Read",
          category: "research",
        }),
        event({ event_type: "tool.completed", span_id: "span-1", outcome: "ok" }),
      ],
      NOW,
    ).get("inst-a");
    expect(channels?.operation).toBeUndefined();
  });

  test("context compaction becomes a bounded operation and closes on completion", () => {
    const started = event({
      event_type: "context.compaction_started",
      ts: at(40),
      context_observation_state: "expected_but_missing",
    });
    const active = projectActivityChannels([started], NOW).get("inst-a");
    expect(active?.operation).toMatchObject({
      value: { label: "Compacting context", category: "other", state: "active" },
      provenance: "event",
      confidence: "high",
      evidence_event_ids: [started.event_id],
    });
    expect(active?.telemetry.value).toBe("degraded");
    expect(active?.telemetry_reason?.value).toBe("context-observation-missing");

    const completed = event({
      event_type: "context.compaction_completed",
      ts: at(10),
      context_observation_state: "expected_but_missing",
    });
    const closed = projectActivityChannels([started, completed], NOW).get("inst-a");
    expect(closed?.operation).toBeUndefined();
  });

  test("an older compaction start cannot reopen after a newer completion", () => {
    const channels = projectActivityChannels(
      [
        event({ event_type: "context.compaction_completed", ts: at(10) }),
        event({ event_type: "context.compaction_started", ts: at(40) }),
      ],
      NOW,
    ).get("inst-a");

    expect(channels?.operation).toBeUndefined();
  });

  test("duplicate event ids are idempotent and do not manufacture repetition", () => {
    const start = event({
      event_type: "tool.requested",
      span_id: "span-duplicate",
      turn_id: "turn-duplicate",
      tool_name: "Read",
      category: "research",
      operation_fingerprint: fingerprint("duplicate"),
    });
    const channels = projectActivityChannels([start, start, start], NOW).get("inst-a");

    expect(channels?.operation?.value.state).toBe("active");
    expect(channels?.operation?.evidence_event_ids).toEqual([start.event_id]);
    expect(channels?.friction).toBeUndefined();
  });

  test("a terminal observed before its request still closes the matching span", () => {
    const requested = event({
      event_type: "tool.requested",
      ts: at(30),
      span_id: "span-inverted",
      turn_id: "turn-inverted",
      operation_fingerprint: fingerprint("inverted"),
    });
    const terminal = event({
      event_type: "tool.completed",
      ts: at(20),
      span_id: "span-inverted",
      turn_id: "turn-inverted",
      outcome: "ok",
    });
    const channels = projectActivityChannels([terminal, requested], NOW).get("inst-a");

    expect(channels?.operation).toBeUndefined();
  });

  test("a completed turn suppresses a late start from that closed scope", () => {
    const channels = projectActivityChannels(
      [
        event({ event_type: "turn.completed", turn_id: "turn-closed", outcome: "ok" }),
        event({
          event_type: "tool.requested",
          span_id: "span-late",
          turn_id: "turn-closed",
          operation_fingerprint: fingerprint("late"),
        }),
      ],
      NOW,
    ).get("inst-a");

    expect(channels?.operation).toBeUndefined();
  });

  test("a recovered terminal can close and seed a retry through requested event linkage", () => {
    const exact = fingerprint("recovered");
    const requested = event({
      event_type: "tool.requested",
      ts: at(40),
      span_id: "span-native",
      turn_id: "turn-recovered",
      operation_fingerprint: exact,
    });
    const recovered = event({
      event_type: "tool.completed",
      ts: at(30),
      span_id: "span-recovered-terminal",
      turn_id: "turn-recovered",
      outcome: "unknown",
      recovered: true,
      recovery_requested_event_id: requested.event_id,
    });
    const retry = event({
      event_type: "tool.requested",
      ts: at(10),
      span_id: "span-retry",
      turn_id: "turn-recovered",
      operation_fingerprint: exact,
    });
    const channels = projectActivityChannels([requested, recovered, retry], NOW).get("inst-a");

    expect(channels?.operation?.value.state).toBe("retrying");
    expect(channels?.operation?.evidence_event_ids).toEqual([recovered.event_id, retry.event_id]);
  });

  test("an open child span remains the leaf when its clock regresses", () => {
    const channels = projectActivityChannels(
      [
        event({
          event_type: "tool.requested",
          ts: at(20),
          span_id: "span-parent",
          tool_name: "Read",
          category: "research",
        }),
        event({
          event_type: "tool.requested",
          ts: at(30),
          span_id: "span-child",
          parent_span_id: "span-parent",
          tool_name: "Edit",
          category: "edit",
          telemetry_issue: "clock-regressed",
        }),
      ],
      NOW,
    ).get("inst-a");

    expect(channels?.operation?.value).toMatchObject({ label: "Editing files", category: "edit" });
    expect(channels?.telemetry.value).toBe("degraded");
    expect(channels?.telemetry_reason?.value).toBe("clock-regressed");
  });

  test("clock-regressed starts do not create retries or repetition friction", () => {
    const exact = fingerprint("regressed");
    const failedStart = event({
      event_type: "tool.requested",
      ts: at(50),
      span_id: "span-failed",
      turn_id: "turn-regressed",
      operation_fingerprint: exact,
    });
    const failedTerminal = event({
      event_type: "tool.completed",
      ts: at(40),
      span_id: "span-failed",
      turn_id: "turn-regressed",
      outcome: "error",
    });
    const regressedStarts = ["one", "two", "three"].map((suffix, index) =>
      event({
        event_type: "tool.requested",
        ts: at(45 + index),
        span_id: `span-regressed-${suffix}`,
        turn_id: "turn-regressed",
        operation_fingerprint: exact,
        telemetry_issue: "clock-regressed",
      }),
    );
    const channels = projectActivityChannels(
      [failedStart, failedTerminal, ...regressedStarts],
      NOW,
    ).get("inst-a");

    expect(channels?.operation?.value.state).toBe("active");
    expect(channels?.friction?.value).toBe("recent-error");
    expect(channels?.telemetry.value).toBe("degraded");
  });

  test("calls an operation long-running only after a same-operation baseline exists", () => {
    const exact = fingerprint("baseline");
    const history = Array.from({ length: 8 }, (_, index) => {
      const span = `span-history-${index}`;
      return [
        event({
          event_type: "tool.requested",
          ts: at(120 - index * 15),
          span_id: span,
          tool_namespace: "fixture",
          tool_name: "Read",
          adapter: "codex",
          instance_id: "inst-history",
          operation_fingerprint: exact,
        }),
        event({
          event_type: "tool.completed",
          ts: at(110 - index * 15),
          span_id: span,
          outcome: "ok",
          duration_ms: 10_000,
          adapter: "codex",
          instance_id: "inst-history",
        }),
      ];
    }).flat();
    const established = projectActivityChannels(
      [
        ...history,
        event({
          event_type: "tool.requested",
          ts: at(40),
          span_id: "span-current",
          tool_namespace: "fixture",
          tool_name: "Read",
          adapter: "codex",
          operation_fingerprint: exact,
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(established?.operation?.value.state).toBe("long-running");
    expect(established?.operation?.value.duration_sample_count).toBe(8);
    expect(established?.operation?.value.long_running_threshold_ms).toBe(30_000);

    const otherAdapter = projectActivityChannels(
      [
        ...history,
        event({
          event_type: "tool.requested",
          ts: at(40),
          span_id: "span-other-adapter",
          tool_namespace: "fixture",
          tool_name: "Read",
          adapter: "cursor",
          operation_fingerprint: exact,
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(otherAdapter?.operation?.value.state).toBe("active");

    const noBaseline = projectActivityChannels(
      [
        event({
          event_type: "tool.requested",
          ts: at(40),
          span_id: "span-only",
          tool_namespace: "fixture",
          tool_name: "Read",
          operation_fingerprint: exact,
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(noBaseline?.operation?.value.state).toBe("active");
  });

  test("retrying requires the same comparable fingerprint in the same turn", () => {
    const same = fingerprint("same");
    const channels = projectActivityChannels(
      [
        event({
          event_type: "tool.requested",
          ts: at(50),
          span_id: "span-1",
          turn_id: "turn-1",
          tool_name: "Write",
          category: "edit",
          operation_fingerprint: same,
        }),
        event({
          event_type: "tool.completed",
          ts: at(40),
          span_id: "span-1",
          turn_id: "turn-1",
          outcome: "error",
        }),
        event({
          event_type: "tool.requested",
          ts: at(10),
          span_id: "span-2",
          turn_id: "turn-1",
          tool_name: "Write",
          category: "edit",
          operation_fingerprint: same,
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(channels?.operation?.value.state).toBe("retrying");
    expect(channels?.operation?.evidence_event_ids).toEqual([
      expect.stringContaining("evt-"),
      expect.stringContaining("evt-"),
    ]);

    const different = projectActivityChannels(
      [
        event({
          event_type: "tool.requested",
          ts: at(50),
          span_id: "span-3",
          turn_id: "turn-1",
          operation_fingerprint: same,
        }),
        event({
          event_type: "tool.completed",
          ts: at(40),
          span_id: "span-3",
          turn_id: "turn-1",
          outcome: "error",
        }),
        event({
          event_type: "tool.requested",
          ts: at(10),
          span_id: "span-4",
          turn_id: "turn-1",
          operation_fingerprint: fingerprint("different"),
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(different?.operation?.value.state).toBe("active");

    const differentEpoch = { ...same, key_epoch: "pep-next" };
    const incomparable = projectActivityChannels(
      [
        event({
          event_type: "tool.requested",
          ts: at(50),
          span_id: "span-epoch-1",
          turn_id: "turn-epoch",
          operation_fingerprint: same,
        }),
        event({
          event_type: "tool.completed",
          ts: at(40),
          span_id: "span-epoch-1",
          turn_id: "turn-epoch",
          outcome: "error",
        }),
        event({
          event_type: "tool.requested",
          ts: at(10),
          span_id: "span-epoch-2",
          turn_id: "turn-epoch",
          operation_fingerprint: differentEpoch,
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(incomparable?.operation?.value.state).toBe("active");
  });

  test("stderr bytes prove output flow but do not imply failure", () => {
    const channels = projectActivityChannels(
      [
        event({
          event_type: "command.started",
          ts: at(20),
          span_id: "span-stderr",
          tool_namespace: "command",
          tool_name: "build",
          operation_fingerprint: fingerprint("stderr"),
        }),
        event({
          event_type: "command.output_observed",
          ts: at(2),
          span_id: "span-stderr",
          output_stream: "stderr",
          output_bytes: 12,
        }),
      ],
      NOW,
    ).get("inst-a");

    expect(channels?.operation?.value.state).toBe("output-flow");
    expect(channels?.friction).toBeUndefined();
  });

  test("three exact starts produce bounded repetition friction until progress", () => {
    const repeat = fingerprint("repeat");
    const starts = [30, 20, 10].map((secondsAgo, index) =>
      event({
        event_type: "tool.requested",
        ts: at(secondsAgo),
        span_id: `span-${index}`,
        turn_id: "turn-repeat",
        operation_fingerprint: repeat,
      }),
    );
    const repeated = projectActivityChannels(starts, NOW).get("inst-a");
    expect(repeated?.friction).toMatchObject({
      value: "repeating-operation",
      provenance: "inferred",
      confidence: "medium",
    });
    expect(repeated?.friction?.evidence_event_ids).toHaveLength(3);

    const progressed = projectActivityChannels(
      [...starts, event({ event_type: "progress.observed", ts: at(5), category: "edit" })],
      NOW,
    ).get("inst-a");
    expect(progressed?.friction).toBeUndefined();
  });

  test("artifact and telemetry cues decay instead of becoming permanent state", () => {
    const fresh = projectActivityChannels(
      [
        event({
          event_type: "artifact.observed",
          ts: at(20),
          artifact_kind: "image",
          artifact_operation: "created",
          artifact_image_hash: "a".repeat(64),
          artifact_image_media_type: "image/png",
          artifact_image_bytes: 4096,
          telemetry_issue: "clock-regressed",
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(fresh?.artifact_cue?.value).toEqual({
      kind: "image",
      operation: "created",
      image_hash: "a".repeat(64),
      image_media_type: "image/png",
      image_bytes: 4096,
    });
    expect(fresh?.telemetry?.value).toBe("degraded");
    expect(fresh?.telemetry_reason?.value).toBe("clock-regressed");
    expect(fresh?.telemetry_reason?.expires_at).toBe(fresh?.telemetry?.expires_at);

    const expired = projectActivityChannels(
      [
        event({
          event_type: "artifact.observed",
          ts: at(400),
          artifact_kind: "report",
          artifact_operation: "published",
          telemetry_issue: "clock-regressed",
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(expired?.artifact_cue).toBeUndefined();
    expect(expired?.telemetry?.value).toBe("unknown");
    expect(expired?.telemetry_reason).toBeUndefined();
  });

  test("denied and overlapping write claims surface target contention without paths", () => {
    const target = fingerprint("target");
    const overlap = projectActivityChannels(
      [
        event({
          instance_id: "inst-a",
          event_type: "coord.claim_changed",
          claim_operation: "acquired",
          claim_access: "write",
          target_fingerprint: target,
        }),
        event({
          instance_id: "inst-b",
          event_type: "coord.claim_changed",
          claim_operation: "acquired",
          claim_access: "write",
          target_fingerprint: target,
        }),
      ],
      NOW,
    );
    expect(overlap.get("inst-a")?.friction?.value).toBe("target-contention");
    expect(overlap.get("inst-b")?.friction?.value).toBe("target-contention");
    expect(JSON.stringify(overlap.get("inst-a"))).not.toContain("workspace_path");

    const released = projectActivityChannels(
      [
        event({
          instance_id: "inst-a",
          event_type: "coord.claim_changed",
          claim_operation: "acquired",
          claim_access: "write",
          target_fingerprint: target,
        }),
        event({
          instance_id: "inst-b",
          event_type: "coord.claim_changed",
          claim_operation: "acquired",
          claim_access: "write",
          target_fingerprint: target,
        }),
        event({
          instance_id: "inst-b",
          event_type: "coord.claim_changed",
          claim_operation: "released",
          claim_access: "write",
          target_fingerprint: target,
        }),
      ],
      NOW,
    );
    expect(released.get("inst-a")?.friction).toBeUndefined();
    expect(released.get("inst-b")?.friction).toBeUndefined();

    const denied = projectActivityChannels(
      [
        event({
          event_type: "coord.claim_changed",
          claim_operation: "denied",
          claim_access: "write",
          target_fingerprint: target,
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(denied?.friction?.value).toBe("target-contention");
  });
});
