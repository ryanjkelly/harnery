import { describe, expect, test } from "bun:test";
import type { SessionFinalizationRequestV3 } from "../core/agents/session-finalizer-v3.ts";
import { pendingFinalizationTraceEntries, traceLine } from "./agents.ts";

describe("agents trace recovery visibility", () => {
  test("renders recovery reasons even when ordinary command noise is hidden", () => {
    expect(
      traceLine(
        {
          event_type: "tool.completed",
          ts: "2026-08-17T20:00:00.000Z",
          payload: {
            outcome: "unknown",
            recovery: { reason: "completion_not_observed_before_turn_end" },
          },
        },
        false,
      ),
    ).toMatchObject({
      detail: "tool · outcome=unknown · RECOVERY reason=completion_not_observed_before_turn_end",
    });
    expect(
      traceLine(
        {
          event_type: "command.completed",
          ts: "2026-08-17T20:00:01.000Z",
          payload: {
            outcome: "unknown",
            recovery: { reason: "command_completion_not_observed" },
          },
        },
        false,
      ),
    ).toMatchObject({
      detail: "outcome=unknown · RECOVERY reason=command_completion_not_observed",
    });
  });

  test("adds only this agent's pending finalization requests", () => {
    const request = {
      format: "harnery-v3-session-finalization-request",
      format_version: 1,
      request_id: "sfr_00000000-0000-7000-8000-000000000001",
      instance_id: "inst_fixture",
      generation_id: "gen_00000000-0000-7000-8000-000000000001",
      trigger: "explicit_end",
      reason: "approved_explicit_end",
      outcome: "succeeded",
      observed_at: "2026-08-17T20:00:00.000Z",
      not_before: "2026-08-17T20:00:00.000Z",
      last_event_id: "evt_00000000-0000-7000-8000-000000000001",
      allowed_open_span_ids: ["span_00000000-0000-7000-8000-000000000001"],
      coordination_finalized: true,
      status: "pending",
    } satisfies SessionFinalizationRequestV3;

    expect(
      pendingFinalizationTraceEntries(
        [request, { ...request, instance_id: "inst_other" }],
        "inst_fixture",
      ),
    ).toEqual([
      expect.objectContaining({
        event_type: "session.finalization_pending",
        detail: expect.stringContaining("allowed_open_spans=1"),
      }),
    ]);
  });
});
