import { describe, expect, test } from "bun:test";

import { eventIdV3, spanIdV3 } from "../../src/core/events/v3/ids";
import {
  type CommandProducerContextV3,
  normalizeCommandEventV3,
} from "../../src/core/events/v3/producers/command";
import { projectSessionEventV3 } from "./session-events";

describe("V3 live command projection", () => {
  test("renders structural command evidence without recovering private bodies", () => {
    const context = commandContext();
    const secret = "API_TOKEN=never-render-this";
    const started = normalizeCommandEventV3(
      "command.started",
      {
        native_command_id: "cmd-1",
        executable: "acme",
        executable_class: "harnery_cli",
        argv: ["acme", "deploy", "--token", secret],
        intent: `deploy with ${secret}`,
        intent_kind: "deploy",
        sensitive_argument_count: 1,
      },
      context,
    )!;
    const completed = normalizeCommandEventV3(
      "command.completed",
      { native_command_id: "cmd-1", exit_code: 0, duration_ms: 42 },
      {
        ...context,
        sequence: 2,
        caused_by: [started.event_id as `evt_${string}`],
        terminal_span: {
          span_id: context.span_id,
          opened_at: "2026-08-16T10:00:00.000Z",
          duration_ms: {
            state: "observed",
            value: 42,
            attestation: "native",
            confidence: "exact",
          },
          open_event_id: started.event_id as `evt_${string}`,
        },
      },
    )!;

    expect(projectSessionEventV3(started)).toMatchObject({
      type: "command.started",
      cmd: "acme",
      intent: "deploy",
      cmd_id: context.span_id,
    });
    expect(projectSessionEventV3(completed)).toMatchObject({
      type: "command.completed",
      exit: 0,
      duration_ms: 42,
      cmd_id: context.span_id,
    });
    expect(
      JSON.stringify([projectSessionEventV3(started), projectSessionEventV3(completed)]),
    ).not.toContain(secret);
  });
});

function commandContext(): CommandProducerContextV3 {
  const generationId = "gen_11111111-1111-7111-8111-111111111111" as const;
  return {
    root_id: "root_fixture",
    instance_id: "inst_fixture",
    session_id: `sid_${"a".repeat(64)}`,
    generation_id: generationId,
    turn_id: `tid_${"b".repeat(64)}`,
    attestation_id: "att_22222222-2222-7222-8222-222222222222",
    producer_id: "prd_session-tee",
    boot_id: "boot_fixture",
    sequence: 1,
    build_id: "build_fixture",
    platform: "linux",
    span_id: spanIdV3(),
    caused_by: [eventIdV3()],
    fingerprintContext: {
      epochId: "pep_fixture",
      epochKey: Buffer.alloc(32, 0x66),
      rootId: "root_fixture",
      generationId,
    },
    attribution_method: "session_env",
  };
}
