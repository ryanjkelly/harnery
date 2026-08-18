import { describe, expect, test } from "bun:test";

import { eventIdV2, spanIdV2 } from "../../src/core/events/v2/ids";
import {
  type CommandProducerContextV2,
  normalizeCommandEventV2,
} from "../../src/core/events/v2/producers/command";
import { projectSessionEventV2 } from "./session-events";

describe("V2 live command projection", () => {
  test("renders structural command evidence without recovering private bodies", () => {
    const context = commandContext();
    const secret = "API_TOKEN=never-render-this";
    const started = normalizeCommandEventV2(
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
    const completed = normalizeCommandEventV2(
      "command.completed",
      { native_command_id: "cmd-1", exit_code: 0, duration_ms: 42 },
      {
        ...context,
        sequence: 2,
        caused_by: [started.event_id as `evt_${string}`],
      },
    )!;

    expect(projectSessionEventV2(started)).toMatchObject({
      type: "command.started",
      cmd: "acme",
      intent: "deploy",
      cmd_id: context.span_id,
    });
    expect(projectSessionEventV2(completed)).toMatchObject({
      type: "command.completed",
      exit: 0,
      duration_ms: 42,
      cmd_id: context.span_id,
    });
    expect(
      JSON.stringify([projectSessionEventV2(started), projectSessionEventV2(completed)]),
    ).not.toContain(secret);
  });
});

function commandContext(): CommandProducerContextV2 {
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
    span_id: spanIdV2(),
    caused_by: [eventIdV2()],
    fingerprintContext: {
      epochId: "pep_fixture",
      epochKey: Buffer.alloc(32, 0x66),
      rootId: "root_fixture",
      generationId,
    },
    attribution_method: "session_env",
  };
}
