import type { EventV2, RuntimeAttestationV2 } from "./contract.ts";
import {
  EVENT_V2_SAFETY_REDUCER_BUILD,
  type GenerationSafetyStateV2,
  reduceSafetyProjectionV2,
  type SafetyProjectionDiagnosticV2,
  type SafetyProjectionV2,
  type WaitProjectionV2,
} from "./projection.ts";
import { type ReadLedgerV2Result, readLedgerV2 } from "./reader.ts";

export const EVENT_V2_COORDINATION_VIEW_VERSION = 1 as const;

export interface CoordinationGenerationViewV2 {
  contract_major: 2;
  instance_id: string;
  session_id: string;
  generation_id: string;
  root_id: string;
  run_id?: string;
  workflow_id?: string;
  identity_id?: string;
  runtime_attestation: RuntimeAttestationV2;
  parent_generation_id?: string;
  delegation_id?: string;
  delegation_role?: string;
  phase: "live" | "terminal";
  activity: "working" | "needs_input" | "idle" | "terminal";
  task_state?: string;
  lifecycle_state?: string;
  presence_state?: string;
  started_at: string;
  last_observed_at: string;
  last_event_id: string;
  source_position: { segment_ordinal: number; byte_offset: number };
  waits: WaitProjectionV2[];
  files_touched: string[];
  progress_count: number;
  last_context_event_id?: string;
  provisional_termination?: GenerationSafetyStateV2["provisional_termination"];
  terminal?: GenerationSafetyStateV2["terminal"];
  evidence_complete: boolean;
  authority_eligible: boolean;
}

export interface CoordinationViewV2 {
  projection_version: typeof EVENT_V2_COORDINATION_VIEW_VERSION;
  contract_major: 2;
  reducer_build_id: typeof EVENT_V2_SAFETY_REDUCER_BUILD;
  source_complete: boolean;
  authority_safe: boolean;
  diagnostics: SafetyProjectionDiagnosticV2[];
  instances: Record<string, CoordinationGenerationViewV2>;
  terminal_generations: Record<string, CoordinationGenerationViewV2>;
  delegations: SafetyProjectionV2["delegations"];
  decisions: SafetyProjectionV2["decisions"];
  health: SafetyProjectionV2["health"];
}

export class CoordinationViewV2Error extends Error {
  constructor(public readonly diagnostics: SafetyProjectionDiagnosticV2[]) {
    super("event_v2_coordination_view:authority_unsafe");
    this.name = "CoordinationViewV2Error";
  }
}

/** Read the complete V2 catalog and derive the disposable coordination view. */
export function readCoordinationViewV2(coordRoot: string): CoordinationViewV2 {
  return projectCoordinationViewV2(readLedgerV2(coordRoot));
}

/**
 * Build the one privacy-safe lifecycle view shared by heartbeat, status,
 * finalization, web, and Codec adapters. This function performs no writes.
 */
export function projectCoordinationViewV2(read: ReadLedgerV2Result): CoordinationViewV2 {
  const safety = reduceSafetyProjectionV2(read);
  const starts = new Map<string, Extract<EventV2, { event_type: "session.started" }>>();
  const eventGeneration = new Map<string, string>();
  for (const { event } of read.events) {
    const generationId = "generation_id" in event.scope ? event.scope.generation_id : undefined;
    if (generationId !== undefined) {
      eventGeneration.set(event.event_id, generationId);
    }
    if (event.event_type === "session.started" && generationId !== undefined) {
      starts.set(generationId, event as Extract<EventV2, { event_type: "session.started" }>);
    }
  }

  const instances: Record<string, CoordinationGenerationViewV2> = {};
  const terminalGenerations: Record<string, CoordinationGenerationViewV2> = {};
  const states = Object.values(safety.generations).sort((left, right) =>
    left.generation_id.localeCompare(right.generation_id),
  );
  for (const state of states) {
    const started = starts.get(state.generation_id);
    if (!started) continue;
    const diagnostics = safety.diagnostics.filter(
      (diagnostic) =>
        diagnostic.generation_id === state.generation_id ||
        diagnostic.subject_instance_id === state.instance_id ||
        (diagnostic.event_id !== undefined &&
          eventGeneration.get(diagnostic.event_id) === state.generation_id) ||
        diagnostic.code === "ledger_incomplete",
    );
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
    const view: CoordinationGenerationViewV2 = {
      contract_major: 2,
      instance_id: state.instance_id,
      session_id: state.session_id,
      generation_id: state.generation_id,
      root_id: started.scope.root_id,
      run_id: started.scope.run_id,
      workflow_id: started.scope.workflow_id,
      identity_id: safety.identities[state.instance_id],
      runtime_attestation: started.payload.runtime_attestation,
      parent_generation_id: (started.links as { parent_generation_id?: string })
        .parent_generation_id,
      delegation_id: delegation?.delegation_id,
      delegation_role: delegation?.role,
      phase: state.phase,
      activity: state.activity,
      task_state: state.task_state,
      lifecycle_state: state.lifecycle_state,
      presence_state: state.presence_state,
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
      evidence_complete: safety.evidence_complete && diagnostics.length === 0,
      authority_eligible: safety.authority_safe && state.phase === "live",
    };
    if (state.phase === "terminal") {
      terminalGenerations[state.generation_id] = view;
    } else if (safety.current_generation_by_instance[state.instance_id] === state.generation_id) {
      instances[state.instance_id] = view;
    }
  }

  return {
    projection_version: EVENT_V2_COORDINATION_VIEW_VERSION,
    contract_major: 2,
    reducer_build_id: EVENT_V2_SAFETY_REDUCER_BUILD,
    source_complete: read.complete,
    authority_safe: safety.authority_safe,
    diagnostics: safety.diagnostics,
    instances,
    terminal_generations: terminalGenerations,
    delegations: safety.delegations,
    decisions: safety.decisions,
    health: safety.health,
  };
}

/** Refuse authority decisions while still allowing callers to render diagnostics. */
export function requireAuthoritySafeCoordinationViewV2(
  view: CoordinationViewV2,
): CoordinationViewV2 {
  if (!view.authority_safe) throw new CoordinationViewV2Error(view.diagnostics);
  return view;
}
