import { describe, expect, test } from "bun:test";
import type { HarneryLogRecordV1 } from "../storage/jsonl.ts";
import type { SupervisorLogFeed } from "./contract.ts";
import {
  projectHookHealth,
  SUPERVISOR_HIGH_COMPLETED_HOOK_RSS_BYTES,
  SUPERVISOR_SLOW_COMPLETED_HOOK_MS,
} from "./hook-health.ts";

describe("supervisor completed hook health", () => {
  test("aggregates sanitized terminal receipts and computes alert counts", () => {
    const now = new Date("2026-08-31T12:05:00.000Z");
    const projected = projectHookHealth(
      feed([
        receipt(1, {
          hook_name: "post-tool-use",
          outcome: "completed",
          duration_ms: 20,
          rss_end_bytes: 100,
        }),
        receipt(2, {
          hook_name: "post-tool-use",
          outcome: "degraded",
          duration_ms: SUPERVISOR_SLOW_COMPLETED_HOOK_MS,
          rss_end_bytes: SUPERVISOR_HIGH_COMPLETED_HOOK_RSS_BYTES,
          error_count: 1,
          error_phases: ["presence-publish"],
        }),
        receipt(3, {
          hook_name: "runtime-context-retry",
          retry_worker: true,
          observed_at: "2026-08-31T12:04:00.000Z",
        }),
      ]),
      now,
    );

    expect(projected.summary).toEqual({
      invocation_count: 3,
      degraded_count: 1,
      faulted_count: 0,
      slow_count: 1,
      high_memory_count: 1,
      retry_count: 1,
    });
    expect(projected.aggregates[0]).toMatchObject({
      hook_name: "runtime-context-retry",
      retry_count: 1,
    });
    expect(projected.aggregates.find((row) => row.hook_name === "post-tool-use")).toMatchObject({
      invocation_count: 2,
      degraded_count: 1,
      duration_p50_ms: 20,
      duration_p95_ms: SUPERVISOR_SLOW_COMPLETED_HOOK_MS,
      rss_end_max_bytes: SUPERVISOR_HIGH_COMPLETED_HOOK_RSS_BYTES,
    });
  });

  test("marks truncated or malformed evidence partial without retaining bad rows", () => {
    const malformed = receipt(1, { hook_name: "bad name" });
    const projected = projectHookHealth({
      ...feed([malformed]),
      lanes: [{ ...feed([malformed]).lanes[0]!, truncated: true }],
    });

    expect(projected.capability).toEqual({
      source_kind: "hook.terminal-log",
      state: "partial",
      reason: "bounded-log-window-truncated",
    });
    expect(projected.malformed_record_count).toBe(1);
    expect(projected.recent).toEqual([]);
  });

  test("states unavailable capability when the hook log lane cannot be read", () => {
    const projected = projectHookHealth({
      schema_version: 1,
      captured_at: "2026-08-31T12:00:00.000Z",
      sequence: 1,
      lanes: [],
      total_records: 0,
      unavailable_families: 0,
    });
    expect(projected.capability).toEqual({
      source_kind: "hook.terminal-log",
      state: "unavailable",
      reason: "hook-log-family-not-visible",
    });
  });
});

function feed(records: HarneryLogRecordV1[]): SupervisorLogFeed {
  return {
    schema_version: 1,
    captured_at: "2026-08-31T12:00:00.000Z",
    sequence: 1,
    lanes: [
      {
        family_id: "agent-hook-debug-log",
        owner: "hook adapter",
        storage_class: "debug-log",
        records,
        truncated: false,
      },
    ],
    total_records: records.length,
    unavailable_families: 0,
  };
}

function receipt(
  sequence: number,
  override: Partial<Record<string, string | number | boolean | readonly string[]>> = {},
): HarneryLogRecordV1 {
  const { observed_at: observedAtValue, ...fieldOverride } = override;
  const fields = {
    receipt_version: 1,
    hook_name: "stop",
    adapter: "codex",
    outcome: "completed",
    exit_contract: "always-zero",
    exit_code: 0,
    duration_ms: 10,
    payload_bytes: 20,
    pid: sequence,
    rss_start_bytes: 50,
    rss_end_bytes: 60,
    rss_delta_bytes: 10,
    retry_worker: false,
    error_count: 0,
    error_phases: [],
    owner_id: "inst_owner",
    ...fieldOverride,
  };
  const observedAt = typeof observedAtValue === "string" ? observedAtValue : undefined;
  return {
    schema: "harnery.log-record/v1",
    kind: "record",
    emitted_at: observedAt ?? `2026-08-31T12:0${sequence}:00.000Z`,
    family_id: "agent-hook-debug-log",
    policy_version: "agent-hook-debug-log-v1",
    component_id: "agent-hook",
    level: "info",
    event: "agent_hook.completed",
    writer_id: `writer-${sequence}`,
    writer_seq: sequence,
    context: {},
    fields,
  };
}
