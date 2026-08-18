import type { EventV2 } from "./contract.ts";
import type { PositionedEventV2, ReadLedgerV2Result } from "./reader.ts";

export const EVENT_V2_SAFETY_REDUCER_BUILD = "event-v2-safety-reducer-v1" as const;
const MAX_PROJECTION_DIAGNOSTICS = 256;

interface GenerationScopeViewV2 {
  instance_id: string;
  session_id: string;
  generation_id: string;
}

export type SafetyProjectionDiagnosticCodeV2 =
  | "ledger_incomplete"
  | "duplicate_session_start"
  | "terminal_without_start"
  | "event_after_terminal"
  | "transition_without_live_subject"
  | "transition_prior_mismatch"
  | "authority_attribution_unverified"
  | "wait_end_without_start"
  | "claim_acquire_conflict"
  | "claim_release_without_acquire"
  | "decision_prior_mismatch"
  | "delegation_duplicate_start"
  | "delegation_complete_without_start"
  | "delegation_identity_mismatch";

export interface SafetyProjectionDiagnosticV2 {
  code: SafetyProjectionDiagnosticCodeV2;
  event_id?: string;
  generation_id?: string;
  subject_instance_id?: string;
  source_code?: string;
  authority_blocking: boolean;
}

export interface WaitProjectionV2 {
  wait_id: string;
  kind: string;
  started_event_id: string;
  started_at: string;
  authority_reference?: string;
  wake_at?: string;
}

export interface GenerationSafetyStateV2 {
  generation_id: string;
  instance_id: string;
  session_id: string;
  started_event_id: string;
  started_at: string;
  last_observed_at: string;
  attestation_id: string;
  phase: "live" | "terminal";
  activity: "working" | "needs_input" | "idle" | "terminal";
  last_event_id: string;
  last_segment_ordinal: number;
  last_byte_offset: number;
  task_state?: string;
  lifecycle_state?: string;
  presence_state?: string;
  provisional_termination?: {
    observation: string;
    event_id: string;
    observed_at: string;
  };
  terminal?: {
    event_id: string;
    observed_at: string;
    outcome: string;
    authority: "native" | "approved";
    reason: string;
  };
  waits: Record<string, WaitProjectionV2>;
  progress_event_ids: string[];
  last_context_event_id?: string;
  resume_count: number;
}

export interface ClaimProjectionV2 {
  key: string;
  subject_instance_id: string;
  actor_instance_id: string;
  target_digest: string;
  target_kind: string;
  target_display?: string;
  access: "read" | "write";
  acquired_event_id: string;
  transaction_id: string;
}

export interface DelegationProjectionV2 {
  delegation_id: string;
  parent_generation_id: string;
  child_generation_id: string;
  role: string;
  started_event_id: string;
  completed_event_id?: string;
  outcome?: string;
}

export interface SafetyProjectionV2 {
  reducer_build_id: typeof EVENT_V2_SAFETY_REDUCER_BUILD;
  evidence_complete: boolean;
  history_complete: boolean;
  authority_safe: boolean;
  diagnostics: SafetyProjectionDiagnosticV2[];
  generations: Record<string, GenerationSafetyStateV2>;
  current_generation_by_instance: Record<string, string>;
  claims: Record<string, ClaimProjectionV2>;
  delegations: Record<string, DelegationProjectionV2>;
  decisions: Record<string, string>;
  identities: Record<string, string>;
  health: Record<string, { severity: string; condition: string; event_id: string }>;
}

/**
 * Deterministically fold only contract-validated V2 rows. Physical ledger
 * order is authoritative; wall-clock values are display evidence, never the
 * conflict-resolution key. An incomplete source makes authority reads fail
 * closed even when the unaffected portions can still be shown diagnostically.
 */
export function reduceSafetyProjectionV2(read: ReadLedgerV2Result): SafetyProjectionV2 {
  const projection: SafetyProjectionV2 = {
    reducer_build_id: EVENT_V2_SAFETY_REDUCER_BUILD,
    evidence_complete: read.complete,
    history_complete: true,
    authority_safe: true,
    diagnostics: [],
    generations: {},
    current_generation_by_instance: {},
    claims: {},
    delegations: {},
    decisions: {},
    identities: {},
    health: {},
  };

  for (const diagnostic of read.diagnostics) {
    const authorityBlocking = authorityBlockingLedgerDiagnostic(diagnostic.code);
    if (authorityBlocking) projection.history_complete = false;
    projection.diagnostics.push({
      code: "ledger_incomplete",
      source_code: diagnostic.code,
      event_id: diagnostic.event_id,
      authority_blocking: authorityBlocking,
    });
  }
  for (const positioned of read.events) applyEvent(projection, positioned);
  projection.authority_safe =
    projection.history_complete &&
    !projection.diagnostics.some((diagnostic) => diagnostic.authority_blocking);
  return projection;
}

function applyEvent(projection: SafetyProjectionV2, positioned: PositionedEventV2): void {
  const event = positioned.event;
  if (event.event_type === "session.started") {
    applySessionStart(projection, positioned, event);
    return;
  }

  switch (event.event_type) {
    case "ledger.genesis":
    case "ledger.activated":
    case "ledger.schema_advanced":
    case "ledger.comparability_advanced":
      return;
    case "coord.task_changed":
      applySubjectTransition(projection, positioned, event, "task_state");
      return;
    case "coord.lifecycle_changed":
      applySubjectTransition(projection, positioned, event, "lifecycle_state");
      return;
    case "coord.presence_changed":
      applySubjectTransition(projection, positioned, event, "presence_state");
      return;
    case "coord.claim_changed":
      applyClaim(projection, event);
      return;
    case "decision.state_changed":
      if (!authorityAttributionVerified(event)) {
        addDiagnostic(projection, {
          code: "authority_attribution_unverified",
          event_id: event.event_id,
        });
        return;
      }
      if (
        event.payload.prior_state !== undefined &&
        projection.decisions[event.payload.decision_id] !== event.payload.prior_state
      ) {
        addDiagnostic(projection, {
          code: "decision_prior_mismatch",
          event_id: event.event_id,
        });
        return;
      }
      projection.decisions[event.payload.decision_id] = event.payload.new_state;
      return;
    case "coord.identity_attested":
      if (!authorityAttributionVerified(event, event.payload.subject_instance_id)) {
        addDiagnostic(projection, {
          code: "authority_attribution_unverified",
          event_id: event.event_id,
          subject_instance_id: event.payload.subject_instance_id,
        });
        return;
      }
      projection.identities[event.payload.subject_instance_id] = event.payload.identity_id;
      return;
    case "health.observed":
      projection.health[event.payload.subsystem] = {
        severity: event.payload.severity,
        condition: event.payload.condition,
        event_id: event.event_id,
      };
      return;
    case "session.termination_observed":
      applyProvisionalTermination(projection, event);
      return;
    case "lifecycle.sweep_observed":
      applySweepObservation(projection, event);
      return;
    case "agent.started":
      applyAgentStarted(projection, event);
      return;
    case "agent.completed":
      applyAgentCompleted(projection, event);
      return;
  }

  const generationId = generationIdOf(event);
  if (!generationId) return;
  const state = projection.generations[generationId];
  if (!state) {
    if (event.event_type === "session.ended") {
      addDiagnostic(projection, {
        code: "terminal_without_start",
        event_id: event.event_id,
        generation_id: generationId,
      });
    }
    return;
  }
  if (state.phase === "terminal") {
    addDiagnostic(projection, {
      code: "event_after_terminal",
      event_id: event.event_id,
      generation_id: generationId,
    });
    return;
  }

  touch(state, positioned);
  switch (event.event_type) {
    case "session.ended":
      if (!authorityAttributionVerified(event, state.instance_id)) {
        addDiagnostic(projection, {
          code: "authority_attribution_unverified",
          event_id: event.event_id,
          generation_id: generationId,
          subject_instance_id: state.instance_id,
        });
        return;
      }
      state.phase = "terminal";
      state.activity = "terminal";
      state.terminal = {
        event_id: event.event_id,
        observed_at: event.time.observed_at,
        outcome: event.payload.outcome,
        authority: event.payload.authority,
        reason: event.payload.reason,
      };
      state.waits = {};
      retargetCurrentGeneration(projection, state.instance_id, generationId);
      return;
    case "session.resumed":
      state.provisional_termination = undefined;
      state.resume_count += 1;
      state.activity = "working";
      return;
    case "session.attestation_changed":
      state.attestation_id = event.attestation_id;
      return;
    case "interaction.wait_started":
      if (!authorityAttributionVerified(event, state.instance_id)) {
        addDiagnostic(projection, {
          code: "authority_attribution_unverified",
          event_id: event.event_id,
          generation_id: generationId,
          subject_instance_id: state.instance_id,
        });
        return;
      }
      state.waits[event.payload.wait_id] = {
        wait_id: event.payload.wait_id,
        kind: event.payload.kind,
        started_event_id: event.event_id,
        started_at: event.time.observed_at,
        authority_reference: event.payload.authority_reference,
        wake_at: event.payload.wake_at,
      };
      state.activity = "needs_input";
      return;
    case "interaction.wait_ended":
      if (!authorityAttributionVerified(event, state.instance_id)) {
        addDiagnostic(projection, {
          code: "authority_attribution_unverified",
          event_id: event.event_id,
          generation_id: generationId,
          subject_instance_id: state.instance_id,
        });
        return;
      }
      if (!state.waits[event.payload.wait_id]) {
        addDiagnostic(projection, {
          code: "wait_end_without_start",
          event_id: event.event_id,
          generation_id: generationId,
        });
        return;
      }
      delete state.waits[event.payload.wait_id];
      state.activity = Object.keys(state.waits).length === 0 ? "working" : "needs_input";
      return;
    case "turn.started":
    case "tool.requested":
    case "command.started":
      state.activity = "working";
      return;
    case "turn.completed":
      state.activity = "idle";
      return;
    case "progress.observed":
      state.progress_event_ids.push(event.event_id);
      return;
    case "context.observed":
    case "context.compaction_started":
    case "context.compaction_completed":
    case "context.checkpointed":
    case "context.recovery_injected":
      state.last_context_event_id = event.event_id;
      return;
  }
}

function applySessionStart(
  projection: SafetyProjectionV2,
  positioned: PositionedEventV2,
  event: Extract<EventV2, { event_type: "session.started" }>,
): void {
  const scope = event.scope as GenerationScopeViewV2;
  const generationId = scope.generation_id;
  if (projection.generations[generationId]) {
    addDiagnostic(projection, {
      code: "duplicate_session_start",
      event_id: event.event_id,
      generation_id: generationId,
    });
    return;
  }
  projection.generations[generationId] = {
    generation_id: generationId,
    instance_id: scope.instance_id,
    session_id: scope.session_id,
    started_event_id: event.event_id,
    started_at: event.time.observed_at,
    last_observed_at: event.time.observed_at,
    attestation_id: event.attestation_id,
    phase: "live",
    activity: "idle",
    last_event_id: event.event_id,
    last_segment_ordinal: positioned.position.segment_ordinal,
    last_byte_offset: positioned.position.byte_offset,
    waits: {},
    progress_event_ids: [],
    resume_count: 0,
  };
  projection.current_generation_by_instance[scope.instance_id] = generationId;
}

function applySubjectTransition(
  projection: SafetyProjectionV2,
  positioned: PositionedEventV2,
  event: Extract<
    EventV2,
    {
      event_type: "coord.task_changed" | "coord.lifecycle_changed" | "coord.presence_changed";
    }
  >,
  field: "task_state" | "lifecycle_state" | "presence_state",
): void {
  const subject = event.payload.subject_instance_id;
  if (!authorityAttributionVerified(event, subject)) {
    addDiagnostic(projection, {
      code: "authority_attribution_unverified",
      event_id: event.event_id,
      subject_instance_id: subject,
    });
    return;
  }
  const generationId = projection.current_generation_by_instance[subject];
  const state = generationId ? projection.generations[generationId] : undefined;
  if (state?.phase !== "live") {
    addDiagnostic(projection, {
      code: "transition_without_live_subject",
      event_id: event.event_id,
      subject_instance_id: subject,
      generation_id: generationId,
    });
    return;
  }
  if (event.payload.prior_state !== undefined && event.payload.prior_state !== state[field]) {
    addDiagnostic(projection, {
      code: "transition_prior_mismatch",
      event_id: event.event_id,
      subject_instance_id: subject,
      generation_id: generationId,
    });
    return;
  }
  state[field] = event.payload.new_state;
  touch(state, positioned);
}

function applyClaim(
  projection: SafetyProjectionV2,
  event: Extract<EventV2, { event_type: "coord.claim_changed" }>,
): void {
  if (event.payload.operation === "denied") return;
  if (!authorityAttributionVerified(event, event.payload.subject_instance_id)) {
    addDiagnostic(projection, {
      code: "authority_attribution_unverified",
      event_id: event.event_id,
      subject_instance_id: event.payload.subject_instance_id,
    });
    return;
  }
  const key = [
    event.payload.subject_instance_id,
    event.payload.target.fingerprint.digest,
    event.payload.access,
  ].join("\0");
  if (event.payload.operation === "released") {
    if (!projection.claims[key]) {
      addDiagnostic(projection, {
        code: "claim_release_without_acquire",
        event_id: event.event_id,
        subject_instance_id: event.payload.subject_instance_id,
      });
      return;
    }
    delete projection.claims[key];
    return;
  }
  const generationId = projection.current_generation_by_instance[event.payload.subject_instance_id];
  const subject = generationId ? projection.generations[generationId] : undefined;
  if (subject?.phase !== "live") {
    addDiagnostic(projection, {
      code: "transition_without_live_subject",
      event_id: event.event_id,
      subject_instance_id: event.payload.subject_instance_id,
      generation_id: generationId,
    });
    return;
  }
  const held = projection.claims[key];
  if (held && held.subject_instance_id !== event.payload.subject_instance_id) {
    addDiagnostic(projection, {
      code: "claim_acquire_conflict",
      event_id: event.event_id,
      subject_instance_id: event.payload.subject_instance_id,
    });
    return;
  }
  // A re-acquire by the current holder is idempotent (the guard may re-assert
  // a holding it cannot see across an epoch boundary): refresh, never conflict.
  projection.claims[key] = {
    key,
    subject_instance_id: event.payload.subject_instance_id,
    actor_instance_id: event.payload.actor_instance_id,
    target_digest: event.payload.target.fingerprint.digest,
    target_kind: event.payload.target.kind,
    target_display: event.payload.target.display,
    access: event.payload.access,
    acquired_event_id: event.event_id,
    transaction_id: event.payload.authority.transaction_id!,
  };
}

function applyProvisionalTermination(
  projection: SafetyProjectionV2,
  event: Extract<EventV2, { event_type: "session.termination_observed" }>,
): void {
  const generationId = projection.current_generation_by_instance[event.payload.subject_instance_id];
  const state = generationId ? projection.generations[generationId] : undefined;
  if (state?.phase !== "live") return;
  state.provisional_termination = {
    observation: event.payload.observation,
    event_id: event.event_id,
    observed_at: event.time.observed_at,
  };
}

function applySweepObservation(
  projection: SafetyProjectionV2,
  event: Extract<EventV2, { event_type: "lifecycle.sweep_observed" }>,
): void {
  const generationId = projection.current_generation_by_instance[event.payload.subject_instance_id];
  const state = generationId ? projection.generations[generationId] : undefined;
  if (state?.phase !== "live") return;
  state.provisional_termination = {
    observation: event.payload.observation,
    event_id: event.event_id,
    observed_at: event.time.observed_at,
  };
}

function applyAgentStarted(
  projection: SafetyProjectionV2,
  event: Extract<EventV2, { event_type: "agent.started" }>,
): void {
  if (projection.delegations[event.payload.delegation_id]) {
    addDiagnostic(projection, {
      code: "delegation_duplicate_start",
      event_id: event.event_id,
      generation_id: generationIdOf(event),
    });
    return;
  }
  projection.delegations[event.payload.delegation_id] = {
    delegation_id: event.payload.delegation_id,
    parent_generation_id: generationIdOf(event)!,
    child_generation_id: event.payload.child_generation_id,
    role: event.payload.role,
    started_event_id: event.event_id,
  };
}

function applyAgentCompleted(
  projection: SafetyProjectionV2,
  event: Extract<EventV2, { event_type: "agent.completed" }>,
): void {
  const delegation = projection.delegations[event.payload.delegation_id];
  if (!delegation) {
    addDiagnostic(projection, {
      code: "delegation_complete_without_start",
      event_id: event.event_id,
      generation_id: generationIdOf(event),
    });
    return;
  }
  if (delegation.child_generation_id !== event.payload.child_generation_id) {
    addDiagnostic(projection, {
      code: "delegation_identity_mismatch",
      event_id: event.event_id,
      generation_id: generationIdOf(event),
    });
    return;
  }
  delegation.completed_event_id = event.event_id;
  delegation.outcome = event.payload.outcome;
}

function generationIdOf(event: EventV2): string | undefined {
  return "generation_id" in event.scope ? event.scope.generation_id : undefined;
}

function touch(state: GenerationSafetyStateV2, positioned: PositionedEventV2): void {
  state.last_event_id = positioned.event.event_id;
  state.last_observed_at = positioned.event.time.observed_at;
  state.last_segment_ordinal = positioned.position.segment_ordinal;
  state.last_byte_offset = positioned.position.byte_offset;
}

/**
 * A superseded twin (same instance, later generation, then session.ended)
 * must not leave `current_generation_by_instance` pointing at the terminal
 * row. The surviving live sibling stays the instance's current generation so
 * whoami/set-task can still see it.
 */
function retargetCurrentGeneration(
  projection: SafetyProjectionV2,
  instanceId: string,
  endedGenerationId: string,
): void {
  if (projection.current_generation_by_instance[instanceId] !== endedGenerationId) return;
  const survivor = Object.values(projection.generations)
    .filter(
      (generation) =>
        generation.instance_id === instanceId &&
        generation.phase === "live" &&
        generation.generation_id !== endedGenerationId,
    )
    .sort(
      (left, right) =>
        right.last_observed_at.localeCompare(left.last_observed_at) ||
        right.generation_id.localeCompare(left.generation_id),
    )[0];
  if (survivor) {
    projection.current_generation_by_instance[instanceId] = survivor.generation_id;
    return;
  }
  delete projection.current_generation_by_instance[instanceId];
}

function addDiagnostic(
  projection: SafetyProjectionV2,
  diagnostic: Omit<SafetyProjectionDiagnosticV2, "authority_blocking">,
): void {
  projection.history_complete = false;
  projection.authority_safe = false;
  if (projection.diagnostics.length < MAX_PROJECTION_DIAGNOSTICS) {
    projection.diagnostics.push({ ...diagnostic, authority_blocking: true });
  }
}

function authorityBlockingLedgerDiagnostic(code: string): boolean {
  return (
    code !== "unresolved_attestation" &&
    code !== "wall_clock_regression_unmarked" &&
    code !== "monotonic_clock_regression"
  );
}

function authorityAttributionVerified(event: EventV2, subjectInstanceId?: string): boolean {
  const attribution = event.provenance.attribution;
  return (
    attribution.state === "verified" &&
    (attribution.subject_instance_id === undefined ||
      subjectInstanceId === undefined ||
      attribution.subject_instance_id === subjectInstanceId)
  );
}
