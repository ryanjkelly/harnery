import { describe, expect, test } from "bun:test";
import { eventV3Fixture, fixtureObject } from "../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "../events/v3/contract.ts";
import type { ReadLedgerV3Result } from "../events/v3/reader.ts";
import { projectSemanticEvidenceV1 } from "./evidence.ts";

const INSTANCE = "inst_fixture";

function semanticRead(extra: EventV3[] = []): ReadLedgerV3Result {
  const start = eventV3Fixture("session.started", 1) as unknown as Extract<
    EventV3,
    { event_type: "session.started" }
  >;
  const scope = fixtureObject(start.scope);
  const generationId = scope.generation_id as string;
  const attestationId = start.attestation_id;
  scope.instance_id = INSTANCE;
  const attestation = fixtureObject(fixtureObject(start.payload).runtime_attestation);
  attestation.adapter = {
    state: "observed",
    value: { id: "codex", version: "0.144.5" },
    attestation: "native",
    confidence: "exact",
  };
  attestation.harness = {
    state: "observed",
    value: { id: "codex", version: "0.144.5" },
    attestation: "native",
    confidence: "exact",
  };

  const tool = eventV3Fixture("tool.requested", 2) as unknown as Extract<
    EventV3,
    { event_type: "tool.requested" }
  >;
  setGeneration(tool, generationId, attestationId);
  fixtureObject(tool.payload).tool = { namespace: "functions", name: "view_image" };
  const output = eventV3Fixture("command.output_observed", 3) as unknown as EventV3;
  setGeneration(output, generationId, attestationId);
  const events: EventV3[] = [
    start,
    tool,
    ...extra.map((event) => (setGeneration(event, generationId, attestationId), event)),
  ];
  return {
    events: events.map((event, index) => ({
      event,
      position: { segment_ordinal: 1, byte_offset: index * 100 },
    })),
    diagnostics: [],
    complete: true,
    genesis_id: "gex_fixture",
    active_schema_digest: start.contract.schema_digest,
    advances: [],
    bytes: 400,
  };
}

function setGeneration(event: EventV3, generationId: string, attestationId: string): void {
  const scope = fixtureObject(event.scope);
  scope.instance_id = INSTANCE;
  scope.generation_id = generationId;
  (event as EventV3 & { attestation_id?: string }).attestation_id = attestationId;
}

describe("semantic evidence projection", () => {
  test("routes a generation to its source harness and reuses controlled operation labels", () => {
    const result = projectSemanticEvidenceV1(semanticRead());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source_harness: "codex",
      operation: { category: "build", label: "Building" },
    });
  });

  test("ignores output-only traffic in the stable evidence digest", () => {
    const baseline = projectSemanticEvidenceV1(semanticRead())[0];
    const output = eventV3Fixture("command.output_observed", 4) as unknown as EventV3;
    const withOutput = projectSemanticEvidenceV1(semanticRead([output]))[0];
    expect(withOutput?.evidence_digest).toBe(baseline?.evidence_digest);
    expect(withOutput?.source.observed_through_event_id).toBe(
      baseline?.source.observed_through_event_id,
    );
  });

  test("changes the digest at a typed wait boundary", () => {
    const baseline = projectSemanticEvidenceV1(semanticRead())[0];
    const wait = eventV3Fixture("wait.started", 4) as unknown as Extract<
      EventV3,
      { event_type: "wait.started" }
    >;
    fixtureObject(wait.payload).kind = "needs_input";
    const waiting = projectSemanticEvidenceV1(semanticRead([wait]))[0];
    expect(waiting?.evidence_digest).not.toBe(baseline?.evidence_digest);
    expect(waiting?.attention).toMatchObject({ kind: "wait", label: "Waiting for input" });
  });
});
