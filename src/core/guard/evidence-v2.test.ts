import { describe, expect, test } from "bun:test";
import { buildEventV2, type EventV2, eventIdV2 } from "../events/v2/index.ts";
import { normalizeRunQualityEventV2 } from "./evidence-v2.ts";

describe("shared V2 run-quality evidence adapter", () => {
  test("normalizes hashes without exposing fingerprint metadata", () => {
    const requested = buildEventV2("tool.requested", {
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

    expect(normalizeRunQualityEventV2(requested)).toEqual([
      expect.objectContaining({
        event_id: requested.event_id,
        kind: "tool_call",
        input_hash: "a".repeat(64),
        target_hash: "c".repeat(64),
      }),
    ]);
    expect(JSON.stringify(normalizeRunQualityEventV2(requested))).not.toContain("pep_fixture");
  });

  test("rejects forged, cross-generation, and failed progress evidence", () => {
    const completed = buildEventV2("tool.completed", {
      ...common(1),
      payload: {
        tool: { namespace: "claude", name: "Write" },
        outcome: "succeeded",
        duration_ms: measurement(10),
        result: { storage: "omitted", media_type: "application/json", bytes: 10 },
      },
    });
    const unknownId = eventIdV2();
    const forged = progress(2, [unknownId], [completed.event_id]);
    expect(normalizeRunQualityEventV2(forged, new Map([[completed.event_id, completed]]))).toEqual(
      [],
    );

    const crossGeneration = buildEventV2("tool.completed", {
      ...common(3, "gen_other"),
      payload: {
        tool: { namespace: "claude", name: "Write" },
        outcome: "succeeded",
        duration_ms: measurement(10),
        result: { storage: "omitted", media_type: "application/json", bytes: 10 },
      },
    });
    const cross = progress(4, [crossGeneration.event_id], [crossGeneration.event_id]);
    expect(
      normalizeRunQualityEventV2(cross, new Map([[crossGeneration.event_id, crossGeneration]])),
    ).toEqual([]);

    const failed = buildEventV2("tool.completed", {
      ...common(5),
      payload: {
        tool: { namespace: "claude", name: "Write" },
        outcome: "failed",
        duration_ms: measurement(10),
        result: { storage: "omitted", media_type: "application/json", bytes: 10 },
      },
    });
    const failedProgress = progress(6, [failed.event_id], [failed.event_id]);
    expect(
      normalizeRunQualityEventV2(failedProgress, new Map([[failed.event_id, failed]])),
    ).toEqual([]);
  });

  test("accepts only causally bound successful progress evidence", () => {
    const completed = buildEventV2("tool.completed", {
      ...common(1),
      payload: {
        tool: { namespace: "claude", name: "Write" },
        outcome: "succeeded",
        duration_ms: measurement(10),
        result: { storage: "omitted", media_type: "application/json", bytes: 4 },
      },
    });
    const observed = progress(2, [completed.event_id], [completed.event_id]);
    expect(
      normalizeRunQualityEventV2(observed, new Map([[completed.event_id, completed]])),
    ).toEqual([expect.objectContaining({ event_id: observed.event_id, kind: "progress" })]);
  });
});

function progress(sequence: number, evidence: string[], causedBy: string[]): EventV2 {
  return buildEventV2("progress.observed", {
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

function fingerprint(hexCharacter: string) {
  return {
    algorithm: "hmac-sha256" as const,
    canonicalizer: "harnery-jcs-nfc-v1" as const,
    key_epoch: "pep_fixture" as const,
    scope: "generation" as const,
    digest: `sha256:${hexCharacter.repeat(64)}` as `sha256:${string}`,
  };
}
