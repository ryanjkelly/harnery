import { describe, expect, test } from "bun:test";
import { buildEventV3, type EventV3, eventIdV3 } from "../events/v3/index.ts";
import { normalizeRunQualityEventV3, normalizeRunQualityPairingV3 } from "./evidence-v3.ts";

describe("shared V3 run-quality evidence adapter", () => {
  test("normalizes hashes without exposing fingerprint metadata", () => {
    const requested = buildEventV3("tool.requested", {
      ...common(1),
      payload: {
        tool: { namespace: "claude", name: "Read" },
        input: { storage: "omitted", media_type: "application/json", bytes: 40 },
        exact_input: fingerprint("a"),
        targets: [
          {
            kind: "workspace_path",
            access: "read",
            fingerprint: fingerprint("c"),
            extractor_version: "fixture-v1",
          },
        ],
      },
    });

    expect(normalizeRunQualityEventV3(requested)).toEqual([
      expect.objectContaining({
        event_id: requested.event_id,
        kind: "tool_call",
        input_hash: "a".repeat(64),
        target_hash: "c".repeat(64),
      }),
    ]);
    expect(JSON.stringify(normalizeRunQualityEventV3(requested))).not.toContain("pep_fixture");
  });

  test("rejects forged, cross-generation, and failed progress evidence", () => {
    const completed = buildEventV3("tool.completed", {
      ...common(1),
      payload: {
        tool: { namespace: "claude", name: "Write" },
        outcome: "succeeded",
        duration_ms: measurement(10),
        span: spanSummary("span_completed"),
        result: { storage: "omitted", media_type: "application/json", bytes: 10 },
      },
    });
    const unknownId = eventIdV3();
    const forged = progress(2, [unknownId], [completed.event_id]);
    expect(normalizeRunQualityEventV3(forged, new Map([[completed.event_id, completed]]))).toEqual(
      [],
    );

    const crossGeneration = buildEventV3("tool.completed", {
      ...common(3, "gen_other"),
      payload: {
        tool: { namespace: "claude", name: "Write" },
        outcome: "succeeded",
        duration_ms: measurement(10),
        span: spanSummary("span_cross"),
        result: { storage: "omitted", media_type: "application/json", bytes: 10 },
      },
    });
    const cross = progress(4, [crossGeneration.event_id], [crossGeneration.event_id]);
    expect(
      normalizeRunQualityEventV3(cross, new Map([[crossGeneration.event_id, crossGeneration]])),
    ).toEqual([]);

    const failed = buildEventV3("tool.completed", {
      ...common(5),
      payload: {
        tool: { namespace: "claude", name: "Write" },
        outcome: "failed",
        duration_ms: measurement(10),
        span: spanSummary("span_failed"),
        result: { storage: "omitted", media_type: "application/json", bytes: 10 },
      },
    });
    const failedProgress = progress(6, [failed.event_id], [failed.event_id]);
    expect(
      normalizeRunQualityEventV3(failedProgress, new Map([[failed.event_id, failed]])),
    ).toEqual([]);
  });

  test("accepts only causally bound successful progress evidence", () => {
    const completed = buildEventV3("tool.completed", {
      ...common(1),
      payload: {
        tool: { namespace: "claude", name: "Write" },
        outcome: "succeeded",
        duration_ms: measurement(10),
        span: spanSummary("span_progress"),
        result: { storage: "omitted", media_type: "application/json", bytes: 4 },
      },
    });
    const observed = progress(2, [completed.event_id], [completed.event_id]);
    expect(
      normalizeRunQualityEventV3(observed, new Map([[completed.event_id, completed]])),
    ).toEqual([expect.objectContaining({ event_id: observed.event_id, kind: "progress" })]);
  });

  test("separates recovered terminals and tool/command pairing gaps", () => {
    const toolRequested = buildEventV3("tool.requested", {
      ...common(1),
      links: { caused_by: [], span_id: "span_tool_fixture" },
      payload: {
        tool: { namespace: "fixture", name: "Read" },
        input: { storage: "omitted", media_type: "application/json", bytes: 4 },
        exact_input: fingerprint("a"),
        targets: [],
      },
    });
    const commandStarted = buildEventV3("command.started", {
      ...common(2),
      links: { caused_by: [], span_id: "span_command_fixture" },
      payload: {
        executable: "fixture",
        executable_class: "fixture",
        exact_command: fingerprint("b"),
        intent_kind: "test",
        intent_length: 4,
        sensitive_argument_count: 0,
      },
    });
    const recovered = buildEventV3("command.completed", {
      ...common(1),
      producer: {
        ...common(1).producer,
        boot_id: "boot_recovery",
        component: "recovery",
      },
      links: { caused_by: [], span_id: "span_recovered_fixture" },
      provenance: {
        ...common(1).provenance,
        attestation: "derived",
        confidence: "medium",
      },
      payload: {
        outcome: "unknown",
        duration_ms: { state: "unknown", reason: "command_completion_not_observed" },
        span: {
          ...spanSummary("span_recovered_fixture"),
          duration_ms: { state: "unknown", reason: "command_completion_not_observed" },
        },
        recovery: { reason: "command_completion_not_observed" },
      },
    });

    expect(normalizeRunQualityEventV3(recovered)).toEqual([
      expect.objectContaining({ kind: "recovered_terminal", event_id: recovered.event_id }),
    ]);
    expect(
      normalizeRunQualityPairingV3([toolRequested, commandStarted]).map(({ kind }) => kind),
    ).toEqual(["tool_pairing_incomplete", "command_pairing_incomplete"]);
  });
});

function progress(sequence: number, evidence: string[], causedBy: string[]): EventV3 {
  return buildEventV3("progress.observed", {
    ...common(sequence),
    links: { caused_by: causedBy },
    payload: {
      kind: "artifact",
      evidence_event_ids: evidence,
      reducer_build_id: "build_fixture",
    },
  });
}

function common(sequence: number, generationId = "gen_fixture") {
  return {
    producer: {
      producer_id: "prd_fixture",
      boot_id: "boot_fixture",
      component: "agent-hook" as const,
      build_id: "build_fixture",
      platform: "linux" as const,
      sequence,
    },
    scope: {
      root_id: "root_fixture" as const,
      instance_id: "inst_fixture" as const,
      session_id: "sid_fixture" as const,
      generation_id: generationId as `gen_${string}`,
    },
    attestation_id: "att_fixture" as const,
    links: { caused_by: [] },
    provenance: {
      source_event: "fixture",
      attestation: "native" as const,
      confidence: "exact" as const,
      attribution: {
        method: "explicit_argument" as const,
        state: "verified" as const,
        subject_instance_id: "inst_fixture",
      },
    },
  };
}

function measurement(value: number) {
  return {
    state: "observed" as const,
    value,
    attestation: "derived" as const,
    confidence: "exact" as const,
  };
}

function spanSummary(spanId: string) {
  return {
    span_id: spanId,
    opened_at: "2026-08-16T19:59:59.000Z",
    duration_ms: measurement(10),
  };
}

function fingerprint(hexCharacter: string) {
  return {
    algorithm: "hmac-sha256" as const,
    canonicalizer: "harnery-jcs-nfc-v1" as const,
    key_epoch: "pep_fixture" as const,
    scope: "generation" as const,
    digest: `sha256:${hexCharacter.repeat(64)}` as `sha256:${string}`,
  };
}
