import { describe, expect, test } from "bun:test";
import { buildEventV2 } from "./builder.ts";
import type { EventV2 } from "./contract.ts";
import {
  CoordinationViewV2Error,
  projectCoordinationViewV2,
  requireAuthoritySafeCoordinationViewV2,
} from "./coordination-view.ts";
import { FinalizationScopeV2Error, projectFinalizationScopeV2 } from "./finalization-view.ts";
import { attestationIdV2, eventIdV2, generationIdV2 } from "./ids.ts";
import { reduceSafetyProjectionV2 } from "./projection.ts";
import type { ReadLedgerV2Result } from "./reader.ts";

describe("event ledger V2 coordination view", () => {
  test("projects one deterministic privacy-safe view for lifecycle consumers", () => {
    const fixture = createFixture();
    fixture.append("session.started", startedPayload(fixture), {
      parent_generation_id: generationIdV2(),
    });
    fixture.append("coord.identity_attested", {
      actor_instance_id: fixture.scope.instance_id,
      subject_instance_id: fixture.scope.instance_id,
      identity_id: "helene",
      method: "registry",
      authority: { transaction_id: "txn_11111111-1111-7111-8111-111111111111" },
    });
    fixture.append(
      "coord.task_changed",
      transitionPayload(fixture, "set", "txn_22222222-2222-7222-8222-222222222222"),
    );
    fixture.append(
      "coord.lifecycle_changed",
      transitionPayload(fixture, "active", "txn_33333333-3333-7333-8333-333333333333"),
    );
    fixture.append("interaction.wait_started", {
      wait_id: "operator_reply",
      kind: "operator_input",
      authority_reference: "txn_wait",
    });
    fixture.append("coord.claim_changed", {
      actor_instance_id: fixture.scope.instance_id,
      subject_instance_id: fixture.scope.instance_id,
      operation: "acquired",
      target: target("workspace_path", "write", "src/z.ts", "a"),
      access: "write",
      authority: { transaction_id: "txn_44444444-4444-7444-8444-444444444444" },
    });
    fixture.append("coord.claim_changed", {
      actor_instance_id: fixture.scope.instance_id,
      subject_instance_id: fixture.scope.instance_id,
      operation: "acquired",
      target: target("workspace_path", "write", "src/a.ts", "b"),
      access: "write",
      authority: { transaction_id: "txn_55555555-5555-7555-8555-555555555555" },
    });
    fixture.append("coord.claim_changed", {
      actor_instance_id: fixture.scope.instance_id,
      subject_instance_id: fixture.scope.instance_id,
      operation: "acquired",
      target: target("external_path", "write", undefined, "c"),
      access: "write",
      authority: { transaction_id: "txn_66666666-6666-7666-8666-666666666666" },
    });
    const context = fixture.append("context.observed", {
      measurement: { state: "unknown", reason: "adapter_did_not_report" },
    });
    fixture.append("progress.observed", {
      kind: "write",
      evidence_event_ids: [context.event_id],
      reducer_build_id: "fixture",
    });
    fixture.append("health.observed", {
      subsystem: "event_writer",
      severity: "healthy",
      condition: "wal_drained",
      action: "none",
      recovered: false,
    });

    const first = projectCoordinationViewV2(fixture.read());
    const second = projectCoordinationViewV2(fixture.read());
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      projection_version: 1,
      contract_major: 2,
      source_complete: true,
      authority_safe: true,
      health: {
        event_writer: { severity: "healthy", condition: "wal_drained" },
      },
    });
    expect(first.instances[fixture.scope.instance_id]).toMatchObject({
      identity_id: "helene",
      activity: "needs_input",
      task_state: "set",
      lifecycle_state: "active",
      files_touched: ["src/a.ts", "src/z.ts"],
      progress_count: 1,
      last_context_event_id: context.event_id,
      evidence_complete: true,
      authority_eligible: true,
    });
    expect(first.instances[fixture.scope.instance_id]?.runtime_attestation.adapter).toEqual({
      state: "observed",
      value: { id: "codex", version: "5.6" },
      attestation: "native",
      confidence: "exact",
    });
    expect(first.instances[fixture.scope.instance_id]?.waits).toHaveLength(1);
  });

  test("keeps sweeps provisional, permits resume, and never exposes terminal claims as live", () => {
    const fixture = createFixture();
    fixture.append("session.started", startedPayload(fixture));
    fixture.append("coord.claim_changed", {
      actor_instance_id: fixture.scope.instance_id,
      subject_instance_id: fixture.scope.instance_id,
      operation: "acquired",
      target: target("workspace_path", "write", "src/live.ts", "d"),
      access: "write",
      authority: { transaction_id: "txn_77777777-7777-7777-8777-777777777777" },
    });
    fixture.append("lifecycle.sweep_observed", {
      subject_instance_id: fixture.scope.instance_id,
      observation: "stale_heartbeat",
      provisional: true,
      age_ms: 600_000,
    });

    const provisional = projectCoordinationViewV2(fixture.read());
    expect(provisional.instances[fixture.scope.instance_id]).toMatchObject({
      phase: "live",
      files_touched: ["src/live.ts"],
      provisional_termination: { observation: "stale_heartbeat" },
    });
    expect(projectFinalizationScopeV2(fixture.read(), fixture.scope.instance_id)).toMatchObject({
      contract_major: 2,
      generation_id: fixture.scope.generation_id,
      files_touched: ["src/live.ts"],
    });

    fixture.append("session.resumed", {
      prior_generation_id: generationIdV2(),
      continuity: "native",
      evidence_reference: "native_resume",
    });
    expect(
      projectCoordinationViewV2(fixture.read()).instances[fixture.scope.instance_id]
        ?.provisional_termination,
    ).toBeUndefined();

    fixture.append("session.ended", endedPayload());
    const terminal = projectCoordinationViewV2(fixture.read());
    expect(terminal.instances).toEqual({});
    expect(terminal.terminal_generations[fixture.scope.generation_id]).toMatchObject({
      phase: "terminal",
      activity: "terminal",
      files_touched: [],
      authority_eligible: false,
      terminal: { outcome: "succeeded", authority: "native" },
    });
    expect(() => projectFinalizationScopeV2(fixture.read(), fixture.scope.instance_id)).toThrow(
      FinalizationScopeV2Error,
    );
  });

  test("separates evidence completeness from authority safety", () => {
    const unresolved = createFixture();
    unresolved.append("session.started", startedPayload(unresolved));
    const incompleteRead = unresolved.read({
      complete: false,
      diagnostic: {
        code: "unresolved_attestation",
        byte_offset: 0,
        event_id: unresolved.startedEventId,
      },
    });
    const displayable = projectCoordinationViewV2(incompleteRead);
    expect(displayable.source_complete).toBe(false);
    expect(displayable.authority_safe).toBe(true);
    expect(displayable.instances[unresolved.scope.instance_id]?.evidence_complete).toBe(false);
    expect(requireAuthoritySafeCoordinationViewV2(displayable)).toBe(displayable);

    const gapRead = unresolved.read({
      complete: false,
      diagnostic: { code: "producer_sequence_gap", byte_offset: 0 },
    });
    const unsafe = projectCoordinationViewV2(gapRead);
    expect(unsafe.authority_safe).toBe(false);
    expect(unsafe.instances[unresolved.scope.instance_id]?.authority_eligible).toBe(false);
    expect(() => requireAuthoritySafeCoordinationViewV2(unsafe)).toThrow(CoordinationViewV2Error);
    expect(() => projectFinalizationScopeV2(gapRead, unresolved.scope.instance_id)).toThrow(
      "event_v2_finalization_scope:authority_unsafe",
    );
  });

  test("keeps a live sibling current after a superseded twin ends", () => {
    const survivor = createFixture();
    survivor.append("session.started", startedPayload(survivor));

    const twinGenerationId = generationIdV2();
    const twinStartedId = eventIdV2();
    const twinScope = {
      ...survivor.scope,
      session_id: `sid_${"c".repeat(64)}` as const,
      generation_id: twinGenerationId,
    };
    survivor.append(
      "session.started",
      startedPayload(survivor, twinGenerationId, twinStartedId),
      {},
      {
        scope: twinScope,
        event_id: twinStartedId,
      },
    );
    survivor.append(
      "session.ended",
      {
        outcome: "interrupted" as const,
        authority: "approved" as const,
        reason: "policy_superseded",
        completeness: { state: "not_applicable" as const },
      },
      {},
      { scope: twinScope },
    );

    const read = survivor.read();
    const projection = reduceSafetyProjectionV2(read);
    expect(projection.authority_safe).toBe(true);
    expect(projection.current_generation_by_instance[survivor.scope.instance_id]).toBe(
      survivor.scope.generation_id,
    );
    expect(projection.generations[twinGenerationId]?.phase).toBe("terminal");
    expect(projection.generations[survivor.scope.generation_id]?.phase).toBe("live");

    const view = projectCoordinationViewV2(read);
    expect(view.instances[survivor.scope.instance_id]?.generation_id).toBe(
      survivor.scope.generation_id,
    );
    expect(view.instances[survivor.scope.instance_id]?.authority_eligible).toBe(true);
    expect(view.terminal_generations[twinGenerationId]?.phase).toBe("terminal");
  });
});

function createFixture() {
  const generationId = generationIdV2();
  const attestationId = attestationIdV2();
  const startedEventId = eventIdV2();
  const scope = {
    root_id: "root_fixture" as const,
    instance_id: "inst_helene" as const,
    session_id: `sid_${"b".repeat(64)}` as const,
    generation_id: generationId,
  };
  const events: ReadLedgerV2Result["events"] = [];
  let sequence = 0;
  return {
    scope,
    attestationId,
    startedEventId,
    append<T extends EventV2["event_type"]>(
      eventType: T,
      payload: Extract<EventV2, { event_type: T }>["payload"],
      extraLinks: Record<string, string> = {},
      options: {
        scope?: typeof scope;
        event_id?: `evt_${string}`;
      } = {},
    ): Extract<EventV2, { event_type: T }> {
      sequence += 1;
      const event = buildEventV2(eventType, {
        ...(eventType === "session.started"
          ? { event_id: options.event_id ?? startedEventId }
          : options.event_id
            ? { event_id: options.event_id }
            : {}),
        producer: {
          producer_id: "prd_projection",
          boot_id: "boot_fixture",
          sequence,
          component: "projector",
          build_id: "build_fixture",
          platform: "linux",
        },
        scope: options.scope ?? scope,
        attestation_id: attestationId,
        links: { caused_by: [], ...extraLinks },
        provenance: {
          source_event: "fixture",
          attestation: "native",
          confidence: "exact",
          attribution: { method: "native_payload", state: "verified" },
        },
        observed_at: `2026-08-16T12:00:${String(sequence).padStart(2, "0")}.000Z`,
        recorded_at: `2026-08-16T12:00:${String(sequence).padStart(2, "0")}.000Z`,
        payload,
      } as never) as Extract<EventV2, { event_type: T }>;
      events.push({
        event,
        position: { segment_ordinal: 0, byte_offset: sequence * 100 },
      });
      return event;
    },
    read(options?: {
      complete: boolean;
      diagnostic: ReadLedgerV2Result["diagnostics"][number];
    }): ReadLedgerV2Result {
      return {
        events: [...events],
        diagnostics: options ? [options.diagnostic] : [],
        complete: options?.complete ?? true,
        bytes: sequence * 100,
      };
    },
  };
}

function startedPayload(
  fixture: ReturnType<typeof createFixture>,
  generationId = fixture.scope.generation_id,
  declaredByEventId = fixture.startedEventId,
) {
  return {
    runtime_attestation: {
      attestation_id: fixture.attestationId,
      generation_id: generationId,
      adapter: {
        state: "observed" as const,
        value: { id: "codex", version: "5.6" },
        attestation: "native" as const,
        confidence: "exact" as const,
      },
      harness: {
        state: "observed" as const,
        value: { id: "codex-cli" },
        attestation: "native" as const,
        confidence: "exact" as const,
      },
      model: {
        state: "observed" as const,
        value: { provider: "openai", id: "gpt-5.6" },
        attestation: "native" as const,
        confidence: "exact" as const,
      },
      capability_profile: `cap_${"c".repeat(64)}` as const,
      declared_by_event_id: declaredByEventId,
    },
    resume: { state: "not_applicable" as const },
  };
}

function transitionPayload(
  fixture: ReturnType<typeof createFixture>,
  state: string,
  transactionId: string,
) {
  return {
    actor_instance_id: fixture.scope.instance_id,
    subject_instance_id: fixture.scope.instance_id,
    new_state: state,
    reason: "operator_transition",
    authority: { transaction_id: transactionId },
  };
}

function target(
  kind: "workspace_path" | "external_path",
  access: "write",
  display: string | undefined,
  digestChar: string,
) {
  return {
    kind,
    access,
    ...(display === undefined ? {} : { display }),
    fingerprint: {
      algorithm: "hmac-sha256" as const,
      canonicalizer: "harnery-jcs-nfc-v1" as const,
      key_epoch: "pep_fixture",
      scope: "root" as const,
      digest: `sha256:${digestChar.repeat(64)}` as const,
    },
    extractor_version: "fixture-v1",
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
