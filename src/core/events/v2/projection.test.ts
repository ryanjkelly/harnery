import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEventV2 } from "./builder.ts";
import { fingerprintV2 } from "./canonical.ts";
import type { EventV2 } from "./contract.ts";
import { attestationIdV2, eventIdV2, generationIdV2 } from "./ids.ts";
import { reduceSafetyProjectionV2 } from "./projection.ts";
import { readActiveLedgerV2 } from "./reader.ts";
import { writeEventV2 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 safety projection", () => {
  test("treats stale observations as provisional and permits a native resume", () => {
    const fixture = createFixture();
    fixture.append("session.started", startedPayload(fixture));
    fixture.append("session.termination_observed", {
      observation: "stale",
      observer_instance_id: "inst_observer",
      subject_instance_id: fixture.scope.instance_id,
      provisional: true,
      reason: "heartbeat_stale",
    });
    fixture.append("session.resumed", {
      prior_generation_id: generationIdV2(),
      continuity: "native",
      evidence_reference: "native_resume",
    });

    const projection = reduceSafetyProjectionV2(readActiveLedgerV2(fixture.root));
    const state = projection.generations[fixture.scope.generation_id]!;
    expect(projection.authority_safe).toBe(true);
    expect(state.phase).toBe("live");
    expect(state.provisional_termination).toBeUndefined();
    expect(state.resume_count).toBe(1);
  });

  test("never seeds from a lone terminal row and never resurrects an ended generation", () => {
    const lone = createFixture();
    lone.append("session.ended", endedPayload());
    const loneProjection = reduceSafetyProjectionV2(readActiveLedgerV2(lone.root));
    expect(loneProjection.generations).toEqual({});
    expect(loneProjection.authority_safe).toBe(false);
    expect(loneProjection.diagnostics.some(({ code }) => code === "terminal_without_start")).toBe(
      true,
    );

    const fixtureWithStart = createFixture();
    const started = fixtureWithStart.append("session.started", startedPayload(fixtureWithStart));
    const ended = fixtureWithStart.append("session.ended", endedPayload(), [started.event_id]);
    fixtureWithStart.append(
      "context.observed",
      { measurement: { state: "unknown", reason: "post_terminal" } },
      [ended.event_id],
    );
    const projection = reduceSafetyProjectionV2(readActiveLedgerV2(fixtureWithStart.root));
    const state = projection.generations[fixtureWithStart.scope.generation_id]!;
    expect(state.phase).toBe("terminal");
    expect(state.last_event_id).toBe(ended.event_id);
    expect(projection.authority_safe).toBe(false);
    expect(projection.diagnostics.at(-1)?.code).toBe("event_after_terminal");
  });

  test("folds task, lifecycle, wait, and claim authority in physical order", () => {
    const fixture = createFixture();
    let priorEventId = fixture.append("session.started", startedPayload(fixture)).event_id;
    priorEventId = fixture.append(
      "coord.task_changed",
      transitionPayload(fixture, undefined, "set", "txn_task"),
      [priorEventId],
    ).event_id;
    priorEventId = fixture.append(
      "coord.lifecycle_changed",
      transitionPayload(fixture, undefined, "active", "txn_lifecycle"),
      [priorEventId],
    ).event_id;
    priorEventId = fixture.append(
      "interaction.wait_started",
      { wait_id: "operator", kind: "operator_input", authority_reference: "txn_lifecycle" },
      [priorEventId],
    ).event_id;
    priorEventId = fixture.append(
      "interaction.wait_ended",
      { wait_id: "operator", outcome: "succeeded", resolution_reference: "operator_reply" },
      [priorEventId],
    ).event_id;
    const target = fingerprintV2(
      {
        epochId: "pep_fixture",
        epochKey: Buffer.alloc(32, 0x44),
        rootId: fixture.scope.root_id,
        generationId: fixture.scope.generation_id,
      },
      "claim-target",
      "src/example.ts",
    );
    priorEventId = fixture.append(
      "coord.claim_changed",
      {
        actor_instance_id: fixture.scope.instance_id,
        subject_instance_id: fixture.scope.instance_id,
        operation: "acquired",
        target,
        access: "write",
        authority: { transaction_id: "txn_11111111-1111-7111-8111-111111111111" },
      },
      [priorEventId],
    ).event_id;
    fixture.append(
      "coord.claim_changed",
      {
        actor_instance_id: fixture.scope.instance_id,
        subject_instance_id: fixture.scope.instance_id,
        operation: "released",
        target,
        access: "write",
        authority: { transaction_id: "txn_22222222-2222-7222-8222-222222222222" },
      },
      [priorEventId],
    );

    const projection = reduceSafetyProjectionV2(readActiveLedgerV2(fixture.root));
    const state = projection.generations[fixture.scope.generation_id]!;
    expect(projection.authority_safe).toBe(true);
    expect(state).toMatchObject({ task_state: "set", lifecycle_state: "active" });
    expect(state.activity).toBe("working");
    expect(state.waits).toEqual({});
    expect(projection.claims).toEqual({});
  });

  test("fails authority closed when the validating reader reports incomplete history", () => {
    const fixture = createFixture();
    const started = fixture.append("session.started", startedPayload(fixture));
    fixture.append(
      "coord.lifecycle_changed",
      transitionPayload(fixture, "missing_prior", "done", "txn_bad"),
      [started.event_id],
    );
    const read = readActiveLedgerV2(fixture.root);
    read.diagnostics.push({ code: "producer_sequence_gap", byte_offset: 0 });
    read.complete = false;

    const projection = reduceSafetyProjectionV2(read);
    expect(projection.history_complete).toBe(false);
    expect(projection.authority_safe).toBe(false);
    expect(projection.diagnostics.map(({ code }) => code)).toEqual([
      "ledger_incomplete",
      "transition_prior_mismatch",
    ]);
  });

  test("keeps outbox-backed authority safe when only runtime attestation is unresolved", () => {
    const fixture = createFixture();
    const started = fixture.append("session.started", startedPayload(fixture));
    fixture.append(
      "coord.lifecycle_changed",
      transitionPayload(fixture, undefined, "active", "txn_lifecycle"),
      [started.event_id],
      `att_${"9".repeat(8)}-${"9".repeat(4)}-7${"9".repeat(3)}-8${"9".repeat(3)}-${"9".repeat(12)}`,
    );

    const projection = reduceSafetyProjectionV2(readActiveLedgerV2(fixture.root));
    expect(projection.evidence_complete).toBe(false);
    expect(projection.history_complete).toBe(true);
    expect(projection.authority_safe).toBe(true);
    expect(projection.generations[fixture.scope.generation_id]?.lifecycle_state).toBe("active");
    expect(projection.diagnostics).toMatchObject([
      { source_code: "unresolved_attestation", authority_blocking: false },
    ]);
  });

  test("refuses an authority mutation whose subject attribution is not verified", () => {
    const fixture = createFixture();
    const started = fixture.append("session.started", startedPayload(fixture));
    const target = fingerprintV2(
      {
        epochId: "pep_fixture",
        epochKey: Buffer.alloc(32, 0x55),
        rootId: fixture.scope.root_id,
        generationId: fixture.scope.generation_id,
      },
      "claim-target",
      "src/unverified.ts",
    );
    fixture.append(
      "coord.claim_changed",
      {
        actor_instance_id: fixture.scope.instance_id,
        subject_instance_id: fixture.scope.instance_id,
        operation: "acquired",
        target,
        access: "write",
        authority: { transaction_id: "txn_66666666-6666-7666-8666-666666666666" },
      },
      [started.event_id],
      fixture.attestationId,
      "unverified",
    );

    const projection = reduceSafetyProjectionV2(readActiveLedgerV2(fixture.root));
    expect(projection.claims).toEqual({});
    expect(projection.authority_safe).toBe(false);
    expect(projection.diagnostics.at(-1)?.code).toBe("authority_attribution_unverified");
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "event-v2-projection-"));
  roots.push(root);
  const generationId = generationIdV2();
  const attestationId = attestationIdV2();
  const startedEventId = eventIdV2();
  const scope = {
    root_id: "root_fixture" as const,
    instance_id: "inst_fixture",
    session_id: `sid_${"b".repeat(64)}` as const,
    generation_id: generationId,
  };
  let sequence = 0;
  return {
    root,
    scope,
    attestationId,
    startedEventId,
    append<T extends EventV2["event_type"]>(
      eventType: T,
      payload: Extract<EventV2, { event_type: T }>["payload"],
      causedBy: string[] = [],
      overrideAttestationId = attestationId,
      attributionState: "verified" | "unverified" = "verified",
    ): Extract<EventV2, { event_type: T }> {
      sequence += 1;
      const event = buildEventV2(eventType, {
        ...(eventType === "session.started" ? { event_id: startedEventId } : {}),
        producer: {
          producer_id: "prd_projection",
          boot_id: "boot_fixture",
          sequence,
          component: "projector",
          build_id: "build_fixture",
          platform: "linux",
        },
        scope,
        attestation_id: overrideAttestationId,
        links: { caused_by: causedBy },
        provenance: {
          source_event: "fixture",
          attestation: "native",
          confidence: "exact",
          attribution: { method: "native_payload", state: attributionState },
        },
        payload,
      } as never) as Extract<EventV2, { event_type: T }>;
      writeEventV2(root, event);
      return event;
    },
  };
}

function startedPayload(fixtureValue: ReturnType<typeof createFixture>) {
  return {
    runtime_attestation: {
      attestation_id: fixtureValue.attestationId,
      generation_id: fixtureValue.scope.generation_id,
      adapter: { state: "unsupported" as const, capability: "adapter_identity" },
      harness: { state: "unsupported" as const, capability: "harness_identity" },
      model: { state: "unsupported" as const, capability: "model_identity" },
      capability_profile: `cap_${"c".repeat(64)}` as const,
      declared_by_event_id: fixtureValue.startedEventId,
    },
    resume: { state: "not_applicable" as const },
  };
}

function endedPayload() {
  return {
    outcome: "succeeded" as const,
    authority: "native" as const,
    reason: "native_clean_exit",
    completeness: { state: "not_applicable" as const },
  };
}

function transitionPayload(
  fixtureValue: ReturnType<typeof createFixture>,
  priorState: string | undefined,
  newState: string,
  transactionLabel: string,
) {
  return {
    actor_instance_id: fixtureValue.scope.instance_id,
    subject_instance_id: fixtureValue.scope.instance_id,
    ...(priorState !== undefined ? { prior_state: priorState } : {}),
    new_state: newState,
    reason: "operator_transition",
    authority: {
      transaction_id: `txn_${transactionLabel === "txn_task" ? "33333333-3333-7333-8333-333333333333" : transactionLabel === "txn_lifecycle" ? "44444444-4444-7444-8444-444444444444" : "55555555-5555-7555-8555-555555555555"}`,
    },
  };
}
