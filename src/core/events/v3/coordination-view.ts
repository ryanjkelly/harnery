import type { EventV3, RuntimeAttestationV3 } from "./contract.ts";
import {
  EVENT_V3_SAFETY_REDUCER_BUILD,
  type GenerationSafetyStateV3,
  reduceSafetyProjectionV3,
  type SafetyProjectionDiagnosticV3,
  type SafetyProjectionV3,
  type WaitProjectionV3,
} from "./projection.ts";
import { type ReadLedgerV3Result, readLedgerV3 } from "./reader.ts";

export const EVENT_V3_COORDINATION_VIEW_VERSION = 1 as const;

export interface CoordinationGenerationViewV3 {
  contract_major: 2;
  instance_id: string;
  session_id: string;
  generation_id: string;
  root_id: string;
  run_id?: string;
  workflow_id?: string;
  workflow_agent_id?: string;
  identity_id?: string;
  runtime_attestation: RuntimeAttestationV3;
  parent_generation_id?: string;
  delegation_id?: string;
  delegation_role?: string;
  phase: "live" | "terminal";
  activity: "working" | "needs_input" | "idle" | "terminal";
  task_state?: string;
  task_state_updated_at?: string;
  lifecycle_state?: string;
  lifecycle_state_updated_at?: string;
  presence_state?: string;
  presence_state_updated_at?: string;
  started_at: string;
  last_observed_at: string;
  last_event_id: string;
  source_position: { segment_ordinal: number; byte_offset: number };
  waits: WaitProjectionV3[];
  files_touched: string[];
  progress_count: number;
  last_context_event_id?: string;
  provisional_termination?: GenerationSafetyStateV3["provisional_termination"];
  terminal?: GenerationSafetyStateV3["terminal"];
  evidence_complete: boolean;
  authority_eligible: boolean;
}

export interface CoordinationViewV3 {
  projection_version: typeof EVENT_V3_COORDINATION_VIEW_VERSION;
  contract_major: 2;
  reducer_build_id: typeof EVENT_V3_SAFETY_REDUCER_BUILD;
  source_complete: boolean;
  /** True when no unscoped authority diagnostic can affect every generation. */
  authority_safe: boolean;
  diagnostics: SafetyProjectionDiagnosticV3[];
  global_diagnostics: SafetyProjectionDiagnosticV3[];
  diagnostics_by_generation: Record<string, SafetyProjectionDiagnosticV3[]>;
  instances: Record<string, CoordinationGenerationViewV3>;
  terminal_generations: Record<string, CoordinationGenerationViewV3>;
  delegations: SafetyProjectionV3["delegations"];
  decisions: SafetyProjectionV3["decisions"];
  health: SafetyProjectionV3["health"];
}

export class CoordinationViewV3Error extends Error {
  constructor(public readonly diagnostics: SafetyProjectionDiagnosticV3[]) {
    super("event_v3_coordination_view:authority_unsafe");
    this.name = "CoordinationViewV3Error";
  }
}

/**
 * A canonical ledger read is immutable and readLedgerV3 returns the same result
 * object until the authority changes. Several web helpers derive the
 * coordination view independently during one server render; without this
 * cache each helper reduces the complete append-only history again.
 *
 * Weak keys bind the projection lifetime to the reader snapshot. A newly
 * appended event produces a new ReadLedgerV3Result and therefore a fresh view.
 */
const coordinationViewCacheV3 = new WeakMap<ReadLedgerV3Result, CoordinationViewV3>();

/** Read the complete V3 catalog and derive the disposable coordination view. */
export function readCoordinationViewV3(coordRoot: string): CoordinationViewV3 {
  return projectCoordinationViewV3(readLedgerV3(coordRoot));
}

/**
 * Build the one privacy-safe lifecycle view shared by heartbeat, status,
 * finalization, web, and Codec adapters. This function performs no writes.
 */
export function projectCoordinationViewV3(read: ReadLedgerV3Result): CoordinationViewV3 {
  const cached = coordinationViewCacheV3.get(read);
  if (cached) return cached;

  const safety = reduceSafetyProjectionV3(read);
  const starts = new Map<string, Extract<EventV3, { event_type: "session.started" }>>();
  const eventGeneration = new Map<string, string>();
  const eventTypes = new Map<string, EventV3["event_type"]>();
  for (const { event } of read.events) {
    eventTypes.set(event.event_id, event.event_type);
    const generationId = "generation_id" in event.scope ? event.scope.generation_id : undefined;
    if (generationId !== undefined) {
      eventGeneration.set(event.event_id, generationId);
    }
    if (event.event_type === "session.started" && generationId !== undefined) {
      starts.set(generationId, event as Extract<EventV3, { event_type: "session.started" }>);
    }
  }

  const { globalDiagnostics, diagnosticsByGeneration } = partitionCoordinationDiagnosticsV3(
    safety,
    eventGeneration,
    eventTypes,
  );
  const globalAuthoritySafe = !globalDiagnostics.some(
    (diagnostic) => diagnostic.authority_blocking,
  );

  const instances: Record<string, CoordinationGenerationViewV3> = {};
  const terminalGenerations: Record<string, CoordinationGenerationViewV3> = {};
  const states = Object.values(safety.generations).sort((left, right) =>
    left.generation_id.localeCompare(right.generation_id),
  );
  for (const state of states) {
    const started = starts.get(state.generation_id);
    if (!started) continue;
    const diagnostics = diagnosticsByGeneration[state.generation_id] ?? [];
    const delegation = Object.values(safety.delegations).find(
      (candidate) => candidate.child_generation_id === state.generation_id,
    );
    const filesTouched = Object.values(safety.claims)
      .filter(
        (claim) =>
          claim.subject_instance_id === state.instance_id &&
          claim.access === "write" &&
          claim.target_kind === "workspace_path" &&
          claim.target_display !== undefined,
      )
      .map((claim) => claim.target_display!)
      .filter((path, index, all) => all.indexOf(path) === index)
      .sort();
    const view: CoordinationGenerationViewV3 = {
      contract_major: 2,
      instance_id: state.instance_id,
      session_id: state.session_id,
      generation_id: state.generation_id,
      root_id: started.scope.root_id,
      run_id: started.scope.run_id,
      workflow_id: started.scope.workflow_id,
      workflow_agent_id: started.scope.workflow_agent_id,
      identity_id: safety.identities[state.instance_id],
      runtime_attestation: started.payload.runtime_attestation,
      parent_generation_id: (started.links as { parent_generation_id?: string })
        .parent_generation_id,
      delegation_id: delegation?.delegation_id,
      delegation_role: delegation?.role,
      phase: state.phase,
      activity: state.activity,
      task_state: state.task_state,
      task_state_updated_at: state.task_state_updated_at,
      lifecycle_state: state.lifecycle_state,
      lifecycle_state_updated_at: state.lifecycle_state_updated_at,
      presence_state: state.presence_state,
      presence_state_updated_at: state.presence_state_updated_at,
      started_at: state.started_at,
      last_observed_at: state.last_observed_at,
      last_event_id: state.last_event_id,
      source_position: {
        segment_ordinal: state.last_segment_ordinal,
        byte_offset: state.last_byte_offset,
      },
      waits: Object.values(state.waits).sort((left, right) =>
        left.started_event_id.localeCompare(right.started_event_id),
      ),
      files_touched: state.phase === "live" ? filesTouched : [],
      progress_count: state.progress_event_ids.length,
      last_context_event_id: state.last_context_event_id,
      provisional_termination: state.provisional_termination,
      terminal: state.terminal,
      evidence_complete: globalDiagnostics.length === 0 && diagnostics.length === 0,
      authority_eligible:
        globalAuthoritySafe &&
        !diagnostics.some((diagnostic) => diagnostic.authority_blocking) &&
        state.phase === "live",
    };
    if (state.phase === "terminal") {
      terminalGenerations[state.generation_id] = view;
    } else if (safety.current_generation_by_instance[state.instance_id] === state.generation_id) {
      instances[state.instance_id] = view;
    }
  }

  const view: CoordinationViewV3 = {
    projection_version: EVENT_V3_COORDINATION_VIEW_VERSION,
    contract_major: 2,
    reducer_build_id: EVENT_V3_SAFETY_REDUCER_BUILD,
    source_complete: read.complete,
    authority_safe: globalAuthoritySafe,
    diagnostics: safety.diagnostics,
    global_diagnostics: globalDiagnostics,
    diagnostics_by_generation: diagnosticsByGeneration,
    instances,
    terminal_generations: terminalGenerations,
    delegations: safety.delegations,
    decisions: safety.decisions,
    health: safety.health,
  };
  coordinationViewCacheV3.set(read, view);
  return view;
}

/**
 * Partition reducer findings at the narrowest authority boundary that can be
 * proven from canonical event attribution. A diagnostic stays global when it
 * concerns shared claim/decision state, lacks a live generation witness, or
 * came from the canonical reader. Reader failures deliberately remain global:
 * an incomplete read cannot produce the append checkpoint that proves causal
 * parents and attestations for later writes.
 */
function partitionCoordinationDiagnosticsV3(
  safety: SafetyProjectionV3,
  eventGeneration: ReadonlyMap<string, string>,
  eventTypes: ReadonlyMap<string, EventV3["event_type"]>,
): {
  globalDiagnostics: SafetyProjectionDiagnosticV3[];
  diagnosticsByGeneration: Record<string, SafetyProjectionDiagnosticV3[]>;
} {
  const globalDiagnostics: SafetyProjectionDiagnosticV3[] = [];
  const diagnosticsByGeneration: Record<string, SafetyProjectionDiagnosticV3[]> = {};
  for (const diagnostic of safety.diagnostics) {
    const generationIds = diagnosticGenerationIdsV3(diagnostic, safety, eventGeneration);
    if (
      generationIds.length === 0 ||
      diagnosticRequiresGlobalAuthorityV3(diagnostic, eventTypes.get(diagnostic.event_id ?? ""))
    ) {
      globalDiagnostics.push(diagnostic);
      continue;
    }
    for (const generationId of generationIds) {
      const generationDiagnostics = diagnosticsByGeneration[generationId] ?? [];
      generationDiagnostics.push(diagnostic);
      diagnosticsByGeneration[generationId] = generationDiagnostics;
    }
  }
  return { globalDiagnostics, diagnosticsByGeneration };
}

function diagnosticGenerationIdsV3(
  diagnostic: SafetyProjectionDiagnosticV3,
  safety: SafetyProjectionV3,
  eventGeneration: ReadonlyMap<string, string>,
): string[] {
  const exact = new Set<string>();
  if (diagnostic.generation_id && safety.generations[diagnostic.generation_id]) {
    exact.add(diagnostic.generation_id);
  }
  const eventGenerationId = diagnostic.event_id
    ? eventGeneration.get(diagnostic.event_id)
    : undefined;
  if (eventGenerationId && safety.generations[eventGenerationId]) exact.add(eventGenerationId);
  if (exact.size > 0) return [...exact].sort();

  const subjectGenerationId = diagnostic.subject_instance_id
    ? safety.current_generation_by_instance[diagnostic.subject_instance_id]
    : undefined;
  return subjectGenerationId && safety.generations[subjectGenerationId]
    ? [subjectGenerationId]
    : [];
}

function diagnosticRequiresGlobalAuthorityV3(
  diagnostic: SafetyProjectionDiagnosticV3,
  eventType: EventV3["event_type"] | undefined,
): boolean {
  if (diagnostic.code === "ledger_incomplete") return true;
  if (diagnostic.code === "decision_prior_mismatch") return true;
  if (
    diagnostic.code === "claim_acquire_conflict" ||
    diagnostic.code === "claim_release_without_acquire"
  ) {
    return true;
  }
  return (
    diagnostic.code === "authority_attribution_unverified" &&
    (eventType === "decision.state_changed" || eventType === "coord.claim_changed")
  );
}

/** Refuse authority decisions while still allowing callers to render diagnostics. */
export function requireAuthoritySafeCoordinationViewV3(
  view: CoordinationViewV3,
): CoordinationViewV3 {
  if (!view.authority_safe) throw new CoordinationViewV3Error(view.diagnostics);
  return view;
}
