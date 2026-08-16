import { describe, expect, test } from "bun:test";
import { canonicalJsonV2 } from "../canonical.ts";
import type { EventV2 } from "../contract.ts";
import { clockIdV2, eventIdV2, spanIdV2 } from "../ids.ts";
import { validateEventV2 } from "../validate.ts";
import { type CommandProducerContextV2, normalizeCommandEventV2 } from "./command.ts";

describe("event ledger V2 session-tee producer", () => {
  test("normalizes a command span without retaining command, intent, or output literals", () => {
    const context = commandContext();
    const secret = "API_TOKEN=super-secret-value";
    const started = normalizeCommandEventV2(
      "command-start",
      {
        native_command_id: "run-123",
        executable: "toolkit",
        executable_class: "harnery_cli",
        argv: ["toolkit", "deploy", "service-web", "--token", secret],
        intent: `deploy the site with ${secret}`,
        intent_kind: "deploy",
        sensitive_argument_count: 1,
      },
      context,
    )!;
    const output = normalizeCommandEventV2(
      "command-output",
      {
        native_command_id: "run-123",
        stream: "stdout",
        output: `deployed with ${secret}`,
        output_lines: 1,
      },
      {
        ...context,
        sequence: 2,
        caused_by: [started.event_id as `evt_${string}`],
      },
    )!;
    const completed = normalizeCommandEventV2(
      "command-completed",
      {
        native_command_id: "run-123",
        exit_code: 0,
        duration_ms: 42,
      },
      {
        ...context,
        sequence: 3,
        caused_by: [output.event_id as `evt_${string}`],
      },
    )!;

    for (const event of [started, output, completed]) {
      expect(validateEventV2(event).ok).toBe(true);
    }
    expect(started.event_type).toBe("command.started");
    expect(output.event_type).toBe("command.output_observed");
    expect(completed.event_type).toBe("command.completed");
    expect(
      (completed as Extract<EventV2, { event_type: "command.completed" }>).payload,
    ).toMatchObject({ outcome: "succeeded", exit_code: 0, duration_ms: 42 });

    const durable = [started, output, completed].map(canonicalJsonV2).join("\n");
    expect(durable).not.toContain(secret);
    expect(durable).not.toContain("deploy the site");
    expect(durable).not.toContain("deployed with");
    expect(durable).not.toContain("service-web");
    expect(durable).toContain('"algorithm":"hmac-sha256"');
  });

  test("uses stable source correlation while separating command and output domains", () => {
    const context = commandContext();
    const started = normalizeCommandEventV2(
      "command-start",
      { native_command_id: "same", argv: ["toolkit", "status"] },
      context,
    )!;
    const output = normalizeCommandEventV2(
      "command-output",
      { native_command_id: "same", output: ["toolkit", "status"] },
      { ...context, sequence: 2 },
    )!;
    expect(started.provenance.source_record_id).toBe(output.provenance.source_record_id);
    const commandFingerprint = (started as Extract<EventV2, { event_type: "command.started" }>)
      .payload.exact_command.digest;
    const outputFingerprint = (
      output as Extract<EventV2, { event_type: "command.output_observed" }>
    ).payload.content_fingerprint?.digest;
    expect(outputFingerprint).toBeDefined();
    expect(commandFingerprint).not.toBe(outputFingerprint);
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
    clock_id: clockIdV2(),
    fingerprintContext: {
      epochId: "pep_fixture",
      epochKey: Buffer.alloc(32, 0x66),
      rootId: "root_fixture",
      generationId,
    },
    attribution_method: "session_env",
  };
}
