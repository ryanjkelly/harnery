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

  test("calls an operation long-running only after a same-operation baseline exists", () => {
    const exact = fingerprint("baseline");
    const history = Array.from({ length: 5 }, (_, index) => {
      const span = `span-history-${index}`;
      return [
        event({
          event_type: "tool.requested",
          ts: at(120 - index * 15),
          span_id: span,
          tool_namespace: "fixture",
          tool_name: "Read",
          operation_fingerprint: exact,
        }),
        event({
          event_type: "tool.completed",
          ts: at(110 - index * 15),
          span_id: span,
          outcome: "ok",
          duration_ms: 10_000,
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
          operation_fingerprint: exact,
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(established?.operation?.value.state).toBe("long-running");

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
          artifact_kind: "report",
          artifact_operation: "published",
          telemetry_issue: "clock-regressed",
        }),
      ],
      NOW,
    ).get("inst-a");
    expect(fresh?.artifact_cue?.value).toEqual({ kind: "report", operation: "published" });
    expect(fresh?.telemetry?.value).toBe("degraded");

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
