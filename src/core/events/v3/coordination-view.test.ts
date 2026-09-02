import { describe, expect, test } from "bun:test";

import { eventV3Fixture, fixtureObject } from "../../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "./contract.ts";
import {
  projectCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "./coordination-view.ts";
import { projectFinalizationScopeV3 } from "./finalization-view.ts";
import type { PositionedEventV3, ReadLedgerV3Result } from "./reader.ts";

function emptyLedger(): ReadLedgerV3Result {
  return {
    events: [],
    diagnostics: [],
    complete: true,
    advances: [],
    bytes: 0,
  };
}

describe("coordination view projection cache", () => {
  test("reuses a projection for the same immutable ledger snapshot", () => {
    const ledger = emptyLedger();
    expect(projectCoordinationViewV3(ledger)).toBe(projectCoordinationViewV3(ledger));
  });

  test("builds a fresh projection for a new ledger snapshot", () => {
    const first = emptyLedger();
    const second = emptyLedger();
    expect(projectCoordinationViewV3(first)).not.toBe(projectCoordinationViewV3(second));
  });
});

describe("coordination authority diagnostic scope", () => {
  test("isolates one generation's reducer diagnostic while its peer remains authoritative", () => {
    const first = sessionStart(1, "inst_first", "sid_first", "gen_first");
    const second = sessionStart(2, "inst_second", "sid_second", "gen_second");
    const mismatch = generationEvent(
      "coord.task_changed",
      3,
      "inst_first",
      "sid_first",
      "gen_first",
    );
    const payload = fixtureObject(mismatch.event.payload);
    payload.subject_instance_id = "inst_first";
    payload.prior_state = "set";
    payload.new_state = "cleared";
    verifyAttribution(mismatch.event, "inst_first");
    const read = readOf(first, second, mismatch);

    const view = projectCoordinationViewV3(read);

    expect(view.authority_safe).toBeTrue();
    expect(view.global_diagnostics).toEqual([]);
    expect(view.diagnostics_by_generation.gen_first?.map(({ code }) => code)).toEqual([
      "transition_prior_mismatch",
    ]);
    expect(view.diagnostics_by_generation.gen_second).toBeUndefined();
    expect(view.instances.inst_first?.authority_eligible).toBeFalse();
    expect(view.instances.inst_first?.evidence_complete).toBeFalse();
    expect(view.instances.inst_second?.authority_eligible).toBeTrue();
    expect(view.instances.inst_second?.evidence_complete).toBeTrue();
    expect(requireAuthoritySafeCoordinationViewV3(view)).toBe(view);
    expect(projectFinalizationScopeV3(read, "inst_second").generation_id).toBe("gen_second");
    expect(() => projectFinalizationScopeV3(read, "inst_first")).toThrow(
      "event_v3_finalization_scope:instance_not_live",
    );
  });

  test("keeps canonical reader diagnostics global even when an event id names a generation", () => {
    const first = sessionStart(1, "inst_first", "sid_first", "gen_first");
    const second = sessionStart(2, "inst_second", "sid_second", "gen_second");
    const read = readOf(first, second);
    read.complete = false;
    read.diagnostics = [
      {
        code: "producer_sequence_gap",
        segment_ordinal: first.position.segment_ordinal,
        byte_offset: first.position.byte_offset,
        event_id: first.event.event_id,
      },
    ];

    const view = projectCoordinationViewV3(read);

    expect(view.source_complete).toBeFalse();
    expect(view.authority_safe).toBeFalse();
    expect(view.global_diagnostics.map(({ source_code }) => source_code)).toEqual([
      "producer_sequence_gap",
    ]);
    expect(view.diagnostics_by_generation).toEqual({});
    expect(view.instances.inst_first?.authority_eligible).toBeFalse();
    expect(view.instances.inst_second?.authority_eligible).toBeFalse();
    expect(() => requireAuthoritySafeCoordinationViewV3(view)).toThrow(
      "event_v3_coordination_view:authority_unsafe",
    );
  });

  test("keeps a shared decision-state mismatch global", () => {
    const first = sessionStart(1, "inst_first", "sid_first", "gen_first");
    const second = sessionStart(2, "inst_second", "sid_second", "gen_second");
    const decision = generationEvent(
      "decision.state_changed",
      3,
      "inst_first",
      "sid_first",
      "gen_first",
    );
    const payload = fixtureObject(decision.event.payload);
    payload.decision_id = "decision-fixture";
    payload.prior_state = "approved";
    payload.new_state = "denied";
    verifyAttribution(decision.event, "inst_first");

    const view = projectCoordinationViewV3(readOf(first, second, decision));

    expect(view.authority_safe).toBeFalse();
    expect(view.global_diagnostics.map(({ code }) => code)).toEqual(["decision_prior_mismatch"]);
    expect(view.diagnostics_by_generation).toEqual({});
    expect(view.instances.inst_first?.authority_eligible).toBeFalse();
    expect(view.instances.inst_second?.authority_eligible).toBeFalse();
  });
});

function sessionStart(
  sequence: number,
  instanceId: string,
  sessionId: string,
  generationId: string,
): PositionedEventV3 {
  const positioned = generationEvent(
    "session.started",
    sequence,
    instanceId,
    sessionId,
    generationId,
  );
  const runtimeAttestation = fixtureObject(
    fixtureObject(positioned.event.payload).runtime_attestation,
  );
  runtimeAttestation.generation_id = generationId;
  return positioned;
}

function generationEvent(
  eventType: string,
  sequence: number,
  instanceId: string,
  sessionId: string,
  generationId: string,
): PositionedEventV3 {
  const event = eventV3Fixture(eventType, sequence) as unknown as EventV3;
  Object.assign(fixtureObject(event.scope), {
    root_id: "root_fixture",
    instance_id: instanceId,
    session_id: sessionId,
    generation_id: generationId,
  });
  return {
    event,
    position: { segment_ordinal: 1, byte_offset: sequence * 100 },
  };
}

function verifyAttribution(event: EventV3, subjectInstanceId: string): void {
  Object.assign(fixtureObject(fixtureObject(event.provenance).attribution), {
    state: "verified",
    subject_instance_id: subjectInstanceId,
  });
}

function readOf(...events: PositionedEventV3[]): ReadLedgerV3Result {
  return {
    events,
    diagnostics: [],
    complete: true,
    advances: [],
    bytes: events.length * 100,
  };
}
