import { describe, expect, test } from "bun:test";
import {
  beginHookHealth,
  finalizeHookHealth,
  observeHookDebug,
  observeHookError,
} from "./health.ts";

describe("hook health receipts", () => {
  test("records a completed invocation with bounded timing and RSS point samples", () => {
    const state = beginHookHealth({
      started_at_ms: 10.9,
      started_rss_bytes: 100,
      event_name: "post-tool-use",
      adapter: "codex",
      payload_bytes: 42,
    });
    state.coord_root = "/repo";
    state.owner_id = "inst_owner";
    observeHookDebug(state, { event_v3_state: "recorded" });

    expect(
      finalizeHookHealth(state, {
        finished_at_ms: 18.8,
        finished_rss_bytes: 160,
        pid: 12,
      }),
    ).toEqual({
      receipt_version: 1,
      hook_name: "post-tool-use",
      adapter: "codex",
      outcome: "completed",
      exit_contract: "always-zero",
      exit_code: 0,
      duration_ms: 7,
      payload_bytes: 42,
      pid: 12,
      rss_start_bytes: 100,
      rss_end_bytes: 160,
      rss_delta_bytes: 60,
      retry_worker: false,
      error_count: 0,
      error_phases: [],
      owner_id: "inst_owner",
      v3_state: "recorded",
    });
  });

  test("prefers degraded over skipped when an internal phase failed", () => {
    const state = beginHookHealth({
      started_at_ms: 0,
      started_rss_bytes: 50,
      event_name: "session-start",
      adapter: "claude-code",
      payload_bytes: 0,
    });
    observeHookDebug(state, { skipped: "no-owner-resolved" });
    observeHookError(state, "presence publish");

    expect(
      finalizeHookHealth(state, {
        finished_at_ms: 5,
        finished_rss_bytes: 40,
        pid: 2,
      }),
    ).toMatchObject({
      outcome: "degraded",
      skipped_reason: "no-owner-resolved",
      error_count: 1,
      error_phases: ["presence-publish"],
      rss_delta_bytes: -10,
    });
  });

  test("marks top-level failures and retry workers explicitly", () => {
    const state = beginHookHealth({
      started_at_ms: 0,
      started_rss_bytes: 0,
      event_name: "runtime-context-retry",
      adapter: "codex",
      payload_bytes: 0,
    });
    observeHookError(state, "top-level");

    expect(
      finalizeHookHealth(state, {
        finished_at_ms: 30,
        finished_rss_bytes: 20,
        pid: 3,
        faulted: true,
      }),
    ).toMatchObject({
      outcome: "faulted",
      exit_code: 0,
      exit_contract: "always-zero",
      retry_worker: true,
    });
  });
});
