import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import type { Adapter } from "../adapter.ts";
import { sessionFinalizationConfig } from "../config.ts";
import { buildEventV2 } from "../events/v2/builder.ts";
import { normalizeNativeIdV2 } from "../events/v2/canonical.ts";
import type { EventV2 } from "../events/v2/contract.ts";
import { fingerprintContextV2 } from "../events/v2/fingerprint-keys.ts";
import { livePlatformV2, resolveLiveEventLedgerRouteV2 } from "../events/v2/live-routing.ts";
import { closeAbandonedCommandSpansV2 } from "../events/v2/producers/command-recorder.ts";
import {
  type ApprovedSessionEndReasonV2,
  drainHookIntakeSpoolV2,
  type HookProducerStateRecordV2,
  listHookProducerStateRecordsV2,
  readHookProducerStateV2,
  recordApprovedSessionEndV2,
  salvageOpenSpansV2,
} from "../events/v2/producers/recorder.ts";
import { readActiveLedgerV2, readLedgerV2 } from "../events/v2/reader.ts";
import { assertEventV2 } from "../events/v2/validate.ts";
import { EVENT_V2_LEDGER_RELATIVE_ROOT, writeEventV2 } from "../events/v2/writer.ts";
import { fsyncParentDirectory } from "../workflow/durable-record.ts";
import { acquireNoClobberLease } from "../workflow/workspaces/leases.ts";
import { readCodexArchiveObservationsV2 } from "./codex-archive-v2.ts";

const REQUEST_FORMAT = "harnery-v2-session-finalization-request" as const;
const REQUEST_VERSION = 1 as const;
/** A pending explicit end older than this is cancelled (never terminalized) so a wedged request cannot outlive its usefulness; re-requesting is cheap. */
const EXPLICIT_END_PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000;

export type SessionFinalizationTriggerV2 =
  | "explicit_end"
  | "verified_archive"
  | "idle_timeout"
  | "parent_terminal"
  | "stale_sweep"
  | "agent_completed"
  | "run_completed"
  | "superseded"
  | "host_disappeared";

export interface SessionArchiveObservationV2 {
  adapter: Adapter;
  native_session_id: string;
  archived: boolean;
  observed_at: string;
}

export interface SessionFinalizationRequestV2 {
  format: typeof REQUEST_FORMAT;
  format_version: typeof REQUEST_VERSION;
  request_id: `sfr_${string}`;
  instance_id: `inst_${string}`;
  generation_id: `gen_${string}`;
  trigger: SessionFinalizationTriggerV2;
  reason: ApprovedSessionEndReasonV2;
  outcome:
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "denied"
    | "interrupted"
    | "unknown";
  observed_at: string;
  not_before: string;
  last_event_id: `evt_${string}`;
  observation_event_id?: `evt_${string}`;
  requested_turn_id?: `tid_${string}`;
  allowed_open_span_ids?: `span_${string}`[];
  coordination_finalized: boolean;
  status: "pending" | "cancelled" | "completed";
  cancelled_at?: string;
  completed_at?: string;
  terminal_event_id?: `evt_${string}`;
}

export interface ReconcileSessionFinalizationOptionsV2 {
  now?: Date;
  archive_observations?: readonly SessionArchiveObservationV2[];
}

export interface ReconcileSessionFinalizationResultV2 {
  observed: number;
  cancelled: number;
  finalized: number;
  already_terminal: number;
  pending: number;
  diagnostics: string[];
}

export interface EndSessionExplicitV2Input {
  coordRoot: string;
  instance_id: `inst_${string}`;
  generation_id: `gen_${string}`;
  outcome?: SessionFinalizationRequestV2["outcome"];
  observed_at?: string;
  coordination_finalized: boolean;
}

export interface RequestSessionEndExplicitV2Input extends EndSessionExplicitV2Input {}

export type RequestSessionEndExplicitV2Result =
  | ReturnType<typeof endSessionExplicitV2>
  | { state: "busy" }
  | { state: "generation_unavailable" }
  | { state: "delegated_work_open"; count: number }
  | { state: "queued"; request: SessionFinalizationRequestV2 }
  | {
      state: "already_requested";
      request: SessionFinalizationRequestV2;
      /** What the pending request is still waiting on, so a repeated explicit end reports its exact blocker instead of a bare refusal. */
      blocker: {
        open_span_ids: `span_${string}`[];
        current_turn_open: boolean;
        pending_age_ms: number;
      };
    };

export interface ObserveHostDisappearedV2Input {
  coordRoot: string;
  instance_id: `inst_${string}`;
  generation_id: `gen_${string}`;
  observed_at?: string;
}

export function endSessionExplicitV2(input: EndSessionExplicitV2Input) {
  const route = resolveLiveEventLedgerRouteV2(input.coordRoot);
  if (route.state !== "v2") return { state: "unavailable" as const, reason: route.reason };
  const observedAt = input.observed_at ?? new Date().toISOString();
  try {
    closeAbandonedCommandSpansV2({
      coordRoot: input.coordRoot,
      mode: route.mode,
      generation_id: input.generation_id,
      build_id: route.build_id,
      platform: livePlatformV2(),
      observed_at: observedAt,
    });
  } catch {
    // Command spans never block a session end; the closer is best effort.
  }
  return recordApprovedSessionEndV2({
    coordRoot: input.coordRoot,
    mode: route.mode,
    instance_id: input.instance_id,
    generation_id: input.generation_id,
    build_id: route.build_id,
    platform: livePlatformV2(),
    reason: "approved_explicit_end",
    outcome: input.outcome ?? "succeeded",
    observed_at: observedAt,
    coordination_finalized: input.coordination_finalized,
    confidence: "exact",
  });
}

/**
 * Request an explicit end without weakening the terminal writer's open-work
 * guard. When invoked from inside an adapter turn, the request is committed
 * first and the stop hook reconciles it after that exact turn has closed.
 */
export function requestSessionEndExplicitV2(
  input: RequestSessionEndExplicitV2Input,
): RequestSessionEndExplicitV2Result {
  const route = resolveLiveEventLedgerRouteV2(input.coordRoot);
  if (route.state !== "v2") return { state: "unavailable" as const, reason: route.reason };
  let lease: ReturnType<typeof acquireNoClobberLease>;
  try {
    lease = acquireFinalizationReconcileLease(input.coordRoot);
  } catch {
    return { state: "busy" as const };
  }
  try {
    const record = listHookProducerStateRecordsV2(input.coordRoot, { includeTerminal: true }).find(
      ({ state }) =>
        state.instance_id === input.instance_id && state.generation_id === input.generation_id,
    );
    if (!record) return { state: "generation_unavailable" as const };
    if (record.state.terminal) {
      return { state: "already_ended" as const, event_id: record.state.last_event_id };
    }
    if (record.state.delegations.length > 0) {
      return {
        state: "delegated_work_open" as const,
        count: record.state.delegations.length,
      };
    }
    if (!record.state.current_turn_id && record.state.spans.length === 0) {
      return endSessionExplicitV2(input);
    }
    const existing = listRequests(input.coordRoot).find(
      (request) =>
        request.status === "pending" &&
        request.generation_id === record.state.generation_id &&
        request.trigger === "explicit_end",
    );
    if (existing) {
      return {
        state: "already_requested" as const,
        request: existing,
        blocker: {
          open_span_ids: record.state.spans.map(({ span_id }) => span_id),
          current_turn_open: Boolean(record.state.current_turn_id),
          pending_age_ms: Math.max(0, Date.now() - Date.parse(existing.observed_at)),
        },
      };
    }
    const observedAt = input.observed_at ?? new Date().toISOString();
    const request = ensureRequest(input.coordRoot, record, {
      trigger: "explicit_end",
      reason: "approved_explicit_end",
      outcome: input.outcome ?? "succeeded",
      observedAt,
      notBefore: observedAt,
      ageMs: 0,
      coordinationFinalized: input.coordination_finalized,
      route,
      requestedTurnId: record.state.current_turn_id,
      allowedOpenSpanIds: record.state.spans.map(({ span_id }) => span_id),
    });
    if (!request) return { state: "generation_unavailable" as const };
    return { state: "queued" as const, request };
  } finally {
    lease.release();
  }
}

export function hasPendingExplicitSessionEndV2(coordRoot: string): boolean {
  return listRequests(coordRoot).some(
    (request) => request.status === "pending" && request.trigger === "explicit_end",
  );
}

/** Accept a host supervisor's observation without granting it terminal authority. */
export function observeHostDisappearedV2(input: ObserveHostDisappearedV2Input) {
  const route = resolveLiveEventLedgerRouteV2(input.coordRoot);
  if (route.state !== "v2") return { state: "unavailable" as const, reason: route.reason };
  let lease: ReturnType<typeof acquireNoClobberLease>;
  try {
    lease = acquireFinalizationReconcileLease(input.coordRoot);
  } catch {
    return { state: "busy" as const };
  }
  try {
    const record = listHookProducerStateRecordsV2(input.coordRoot).find(
      ({ state }) =>
        state.instance_id === input.instance_id && state.generation_id === input.generation_id,
    );
    if (!record) return { state: "generation_unavailable" as const };
    const observedAt = input.observed_at ?? new Date().toISOString();
    const policy = sessionFinalizationConfig(input.coordRoot);
    const request = ensureRequest(input.coordRoot, record, {
      trigger: "host_disappeared",
      reason: "policy_host_disappeared",
      outcome: "interrupted",
      observedAt,
      notBefore: addSeconds(observedAt, policy.cascadeGraceSeconds),
      ageMs: 0,
      coordinationFinalized: false,
      route,
    });
    return request
      ? { state: "observed" as const, request }
      : { state: "already_observed" as const };
  } finally {
    lease.release();
  }
}

export function reconcileSessionFinalizationV2(
  coordRoot: string,
  options: ReconcileSessionFinalizationOptionsV2 = {},
): ReconcileSessionFinalizationResultV2 {
  const result: ReconcileSessionFinalizationResultV2 = {
    observed: 0,
    cancelled: 0,
    finalized: 0,
    already_terminal: 0,
    pending: 0,
    diagnostics: [],
  };
  const route = resolveLiveEventLedgerRouteV2(coordRoot);
  if (route.state !== "v2") {
    result.diagnostics.push(route.reason);
    return result;
  }
  let reconcileLease: ReturnType<typeof acquireNoClobberLease>;
  try {
    reconcileLease = acquireFinalizationReconcileLease(coordRoot);
  } catch {
    result.diagnostics.push("reconciliation_already_running");
    return result;
  }
  try {
    // Terminal drain: pick up intake records whose appender lost the state
    // lease and exited with no later signal to drain them.
    try {
      drainHookIntakeSpoolV2(coordRoot);
    } catch {
      result.diagnostics.push("intake_drain_failed");
    }
    const now = options.now ?? new Date();
    const policy = sessionFinalizationConfig(coordRoot);
    const ledger =
      route.mode === "candidate" ? readActiveLedgerV2(coordRoot) : readLedgerV2(coordRoot);
    if (!ledger.complete || ledger.diagnostics.length > 0) {
      result.diagnostics.push("ledger_not_authority_safe");
      return result;
    }
    const records = listHookProducerStateRecordsV2(coordRoot, { includeTerminal: true });
    const live = records.filter(({ state }) => !state.terminal);
    const events = ledger.events.map(({ event }) => event);
    const lastByGeneration = lastEventsByGeneration(events);

    const archiveScan = options.archive_observations
      ? { observations: options.archive_observations, diagnostics: [] }
      : readCodexArchiveObservationsV2(coordRoot, { observedAt: now.toISOString() });
    result.diagnostics.push(...archiveScan.diagnostics);
    for (const observation of archiveScan.observations) {
      const state = readHookProducerStateV2(
        coordRoot,
        observation.adapter,
        observation.native_session_id,
      );
      if (!state) continue;
      if (!observation.archived) {
        result.cancelled += cancelPendingRequests(
          coordRoot,
          state.generation_id,
          "verified_archive",
          observation.observed_at,
        );
        continue;
      }
      const record = records.find(
        ({ state: candidate }) => candidate.generation_id === state.generation_id,
      );
      if (!record || record.state.terminal || !record.state.last_event_id) continue;
      const created = ensureRequest(coordRoot, record, {
        trigger: "verified_archive",
        reason: "approved_verified_archive",
        outcome: "unknown",
        observedAt: observation.observed_at,
        notBefore: addSeconds(observation.observed_at, policy.archiveGraceSeconds),
        ageMs: 0,
        coordinationFinalized: false,
        route,
      });
      if (created) result.observed += 1;
    }

    for (const record of live) {
      const last = lastByGeneration.get(record.state.generation_id);
      if (!last || !record.state.last_event_id) continue;
      const ageMs = Math.max(0, now.getTime() - Date.parse(last.time.recorded_at));
      if (ageMs >= policy.idleObserveSeconds * 1_000) {
        const created = ensureRequest(coordRoot, record, {
          trigger: "idle_timeout",
          reason: "policy_idle_timeout",
          outcome: "unknown",
          observedAt: now.toISOString(),
          notBefore: new Date(
            Date.parse(last.time.recorded_at) + policy.idleFinalizeSeconds * 1_000,
          ).toISOString(),
          ageMs,
          coordinationFinalized: false,
          route,
        });
        if (created) result.observed += 1;
      }
    }

    result.observed += observeCascades(
      coordRoot,
      route,
      records,
      events,
      lastByGeneration,
      now,
      policy.cascadeGraceSeconds,
    );

    for (const request of listRequests(coordRoot).filter(
      (candidate) => candidate.status === "pending",
    )) {
      const record = records.find(
        ({ state }) =>
          state.instance_id === request.instance_id &&
          state.generation_id === request.generation_id,
      );
      if (!record || record.state.terminal) {
        completeRequest(coordRoot, request, record?.state.last_event_id);
        result.already_terminal += 1;
        continue;
      }
      if (request.trigger === "explicit_end") {
        let state = explicitEndReadiness(request, record, events);
        if (state === "pending" && explicitEndSalvageEligible(request, record, events)) {
          // Salvage (ADR 0078) precedes expiry: the requested turn is closed
          // and every remaining span is in the approved set, so derived
          // recovery terminals complete the end instead of cancelling it.
          const salvaged = salvageOpenSpansV2({
            coordRoot,
            mode: route.mode,
            instance_id: request.instance_id,
            generation_id: request.generation_id,
            allowed_span_ids: request.allowed_open_span_ids ?? [],
            requested_turn_id: request.requested_turn_id,
            build_id: route.build_id,
            platform: livePlatformV2(),
            observed_at: now.toISOString(),
          });
          if (salvaged.state === "salvaged") {
            result.diagnostics.push(
              `salvaged_explicit_end:${request.request_id}:${salvaged.closed}`,
            );
            state = "ready";
          } else {
            // Salvage-eligible requests are exempt from expiry; retry next pass.
            result.pending += 1;
            continue;
          }
        }
        if (state === "pending") {
          // Expiry: a pending explicit end whose allowed span never closes has
          // no other escape (readiness re-evaluates to pending forever, and a
          // second request is refused while one is pending). Cancelling is
          // safe and non-destructive — the agent can simply re-request — so
          // age alone is sufficient authority to cancel, never to terminalize.
          const pendingAgeMs = now.getTime() - Date.parse(request.observed_at);
          if (pendingAgeMs > EXPLICIT_END_PENDING_EXPIRY_MS) {
            cancelRequest(coordRoot, request, now.toISOString());
            result.cancelled += 1;
            result.diagnostics.push(`expired_pending_explicit_end:${request.request_id}`);
            continue;
          }
          result.pending += 1;
          continue;
        }
        if (state === "cancel") {
          cancelRequest(coordRoot, request, now.toISOString());
          result.cancelled += 1;
          continue;
        }
      } else if (record.state.last_event_id !== request.last_event_id) {
        cancelRequest(coordRoot, request, now.toISOString());
        result.cancelled += 1;
        continue;
      }
      if (Date.parse(request.not_before) > now.getTime()) {
        result.pending += 1;
        continue;
      }
      try {
        closeAbandonedCommandSpansV2({
          coordRoot,
          mode: route.mode,
          generation_id: request.generation_id,
          build_id: route.build_id,
          platform: livePlatformV2(),
          observed_at: now.toISOString(),
        });
      } catch {
        result.diagnostics.push(`command_closer_failed:${request.request_id}`);
      }
      const ended = recordApprovedSessionEndV2({
        coordRoot,
        mode: route.mode,
        instance_id: request.instance_id,
        generation_id: request.generation_id,
        build_id: route.build_id,
        platform: livePlatformV2(),
        reason: request.reason,
        outcome: request.outcome,
        observed_at: now.toISOString(),
        caused_by_event_id: request.observation_event_id,
        coordination_finalized: request.coordination_finalized,
        confidence:
          request.trigger === "verified_archive" || request.trigger === "explicit_end"
            ? "exact"
            : "medium",
      });
      if (ended.state === "recorded") {
        completeRequest(coordRoot, request, ended.event.event_id as `evt_${string}`);
        result.finalized += 1;
      } else if (ended.state === "already_ended") {
        completeRequest(coordRoot, request, ended.event_id);
        result.already_terminal += 1;
      } else {
        result.diagnostics.push(`${request.request_id}:${ended.state}`);
        result.pending += 1;
      }
    }
    return result;
  } finally {
    reconcileLease.release();
  }
}

function observeCascades(
  coordRoot: string,
  route: Extract<ReturnType<typeof resolveLiveEventLedgerRouteV2>, { state: "v2" }>,
  records: HookProducerStateRecordV2[],
  events: EventV2[],
  lastByGeneration: Map<string, EventV2>,
  now: Date,
  graceSeconds: number,
): number {
  let observed = 0;
  const liveByGeneration = new Map<`gen_${string}`, HookProducerStateRecordV2>(
    records
      .filter(({ state }) => !state.terminal)
      .map((record) => [record.state.generation_id, record]),
  );
  const starts = new Map<`gen_${string}`, Extract<EventV2, { event_type: "session.started" }>>();
  const terminals = new Map<`gen_${string}`, Extract<EventV2, { event_type: "session.ended" }>>();
  for (const event of events) {
    const generation = "generation_id" in event.scope ? event.scope.generation_id : undefined;
    if (event.event_type === "session.started" && generation) {
      starts.set(generation as `gen_${string}`, event);
    }
    if (event.event_type === "session.ended" && generation) {
      terminals.set(generation as `gen_${string}`, event);
    }
  }

  for (const [generationId, start] of starts) {
    const parent = (start.links as { parent_generation_id?: string }).parent_generation_id;
    if (!parent) continue;
    const terminal = terminals.get(parent as `gen_${string}`);
    const record = liveByGeneration.get(generationId);
    if (!terminal || !record?.state.last_event_id) continue;
    const last = lastByGeneration.get(generationId);
    if (!last || Date.parse(last.time.recorded_at) > Date.parse(terminal.time.recorded_at))
      continue;
    if (
      ensureRequest(coordRoot, record, {
        trigger: "parent_terminal",
        reason: "policy_parent_terminal",
        outcome: "cancelled",
        observedAt: terminal.time.recorded_at,
        notBefore: addSeconds(terminal.time.recorded_at, graceSeconds),
        ageMs: 0,
        coordinationFinalized: false,
        route,
        cause: terminal.event_id as `evt_${string}`,
      })
    )
      observed += 1;
  }

  for (const event of events) {
    if (event.event_type === "agent.completed") {
      const record = liveByGeneration.get(event.payload.child_generation_id as `gen_${string}`);
      if (!record?.state.last_event_id) continue;
      const last = lastByGeneration.get(record.state.generation_id);
      if (!last || Date.parse(last.time.recorded_at) > Date.parse(event.time.recorded_at)) continue;
      if (
        ensureRequest(coordRoot, record, {
          trigger: "agent_completed",
          reason: "policy_agent_completed",
          outcome: event.payload.outcome,
          observedAt: event.time.recorded_at,
          notBefore: event.time.recorded_at,
          ageMs: 0,
          coordinationFinalized: false,
          route,
          cause: event.event_id as `evt_${string}`,
        })
      )
        observed += 1;
    }
    if (event.event_type === "run.completed" && "run_id" in event.scope) {
      for (const [generationId, start] of starts) {
        if (!("run_id" in start.scope) || start.scope.run_id !== event.scope.run_id) continue;
        const record = liveByGeneration.get(generationId);
        const last = lastByGeneration.get(generationId);
        if (!record?.state.last_event_id || !last) continue;
        if (Date.parse(last.time.recorded_at) > Date.parse(event.time.recorded_at)) continue;
        if (
          ensureRequest(coordRoot, record, {
            trigger: "run_completed",
            reason: "policy_run_completed",
            outcome: event.payload.outcome,
            observedAt: event.time.recorded_at,
            notBefore: event.time.recorded_at,
            ageMs: 0,
            coordinationFinalized: false,
            route,
            cause: event.event_id as `evt_${string}`,
          })
        )
          observed += 1;
      }
    }
    if (
      event.event_type === "lifecycle.sweep_observed" &&
      event.payload.observation === "stale_sweep"
    ) {
      const record = records.find(
        ({ state }) => !state.terminal && state.instance_id === event.payload.subject_instance_id,
      );
      const last = record ? lastByGeneration.get(record.state.generation_id) : undefined;
      if (!record?.state.last_event_id || !last) continue;
      if (Date.parse(last.time.recorded_at) > Date.parse(event.time.recorded_at)) continue;
      if (
        ensureRequest(coordRoot, record, {
          trigger: "stale_sweep",
          reason: "policy_stale_sweep",
          outcome: "unknown",
          observedAt: event.time.recorded_at,
          notBefore: addSeconds(event.time.recorded_at, graceSeconds),
          ageMs: event.payload.age_ms,
          coordinationFinalized: false,
          route,
          cause: event.event_id as `evt_${string}`,
        })
      )
        observed += 1;
    }
  }

  const byInstance = new Map<string, HookProducerStateRecordV2[]>();
  for (const record of records.filter(({ state }) => !state.terminal)) {
    const group = byInstance.get(record.state.instance_id) ?? [];
    group.push(record);
    byInstance.set(record.state.instance_id, group);
  }
  for (const group of byInstance.values()) {
    if (group.length < 2) continue;
    group.sort(
      (left, right) =>
        Date.parse(lastByGeneration.get(right.state.generation_id)?.time.recorded_at ?? "") -
        Date.parse(lastByGeneration.get(left.state.generation_id)?.time.recorded_at ?? ""),
    );
    for (const record of group.slice(1)) {
      if (!record.state.last_event_id) continue;
      if (
        ensureRequest(coordRoot, record, {
          trigger: "superseded",
          reason: "policy_superseded",
          outcome: "interrupted",
          observedAt: now.toISOString(),
          notBefore: now.toISOString(),
          ageMs: 0,
          coordinationFinalized: false,
          route,
        })
      )
        observed += 1;
    }
  }
  return observed;
}

interface RequestInput {
  trigger: SessionFinalizationTriggerV2;
  reason: ApprovedSessionEndReasonV2;
  outcome: SessionFinalizationRequestV2["outcome"];
  observedAt: string;
  notBefore: string;
  ageMs: number;
  coordinationFinalized: boolean;
  route: Extract<ReturnType<typeof resolveLiveEventLedgerRouteV2>, { state: "v2" }>;
  cause?: `evt_${string}`;
  requestedTurnId?: `tid_${string}`;
  allowedOpenSpanIds?: `span_${string}`[];
}

function ensureRequest(
  coordRoot: string,
  record: HookProducerStateRecordV2,
  input: RequestInput,
): SessionFinalizationRequestV2 | null {
  if (
    listRequests(coordRoot).some(
      (request) =>
        request.status === "pending" &&
        request.generation_id === record.state.generation_id &&
        request.trigger === input.trigger,
    )
  )
    return null;
  if (!record.state.last_event_id) return null;
  const request: SessionFinalizationRequestV2 = {
    format: REQUEST_FORMAT,
    format_version: REQUEST_VERSION,
    request_id: `sfr_${randomUUID()}`,
    instance_id: record.state.instance_id,
    generation_id: record.state.generation_id,
    trigger: input.trigger,
    reason: input.reason,
    outcome: input.outcome,
    observed_at: input.observedAt,
    not_before: input.notBefore,
    last_event_id: record.state.last_event_id,
    ...(input.requestedTurnId ? { requested_turn_id: input.requestedTurnId } : {}),
    ...(input.allowedOpenSpanIds ? { allowed_open_span_ids: [...input.allowedOpenSpanIds] } : {}),
    coordination_finalized: input.coordinationFinalized,
    status: "pending",
  };
  const observation = buildObservationEvent(coordRoot, record, request, input);
  request.observation_event_id = observation.event_id as `evt_${string}`;
  writeEventV2(coordRoot, observation);
  writeRequest(coordRoot, request, true);
  return request;
}

function explicitEndReadiness(
  request: SessionFinalizationRequestV2,
  record: HookProducerStateRecordV2,
  events: EventV2[],
): "pending" | "ready" | "cancel" {
  if (record.state.delegations.length > 0) return "cancel";
  if (record.state.current_turn_id && record.state.current_turn_id !== request.requested_turn_id)
    return "cancel";
  const allowedSpans = new Set(request.allowed_open_span_ids ?? []);
  if (record.state.spans.some(({ span_id }) => !allowedSpans.has(span_id))) return "cancel";
  if (record.state.current_turn_id || record.state.spans.length > 0) return "pending";
  if (!request.observation_event_id || !request.requested_turn_id) return "cancel";
  const observationIndex = events.findIndex(
    (event) => event.event_id === request.observation_event_id,
  );
  if (observationIndex < 0) return "cancel";
  const later = laterGenerationEvents(events, observationIndex, request.generation_id);
  if (later.some(isNativeNewWork)) return "cancel";
  return later.some(
    (event) =>
      event.event_type === "turn.completed" &&
      "turn_id" in event.scope &&
      event.scope.turn_id === request.requested_turn_id,
  )
    ? "ready"
    : "pending";
}

function laterGenerationEvents(
  events: EventV2[],
  observationIndex: number,
  generationId: `gen_${string}`,
): EventV2[] {
  return events
    .slice(observationIndex + 1)
    .filter(
      (event) => "generation_id" in event.scope && event.scope.generation_id === generationId,
    );
}

/**
 * Only NATIVE new work cancels a pending explicit end (ADR 0078, invariant 3):
 * derived recovery events — including the derived requests post-only call
 * classes generate constantly — never revoke an approved end.
 */
function isNativeNewWork(event: EventV2): boolean {
  return (
    event.provenance.attestation !== "derived" &&
    [
      "turn.started",
      "tool.requested",
      "agent.delegated",
      "agent.started",
      "session.resumed",
    ].includes(event.event_type)
  );
}

/**
 * Salvage eligibility (ADR 0078): the requested turn has a committed terminal
 * (or the request captured no turn and the state shows none open), no native
 * new work followed the request, and every remaining open span is in the
 * approved set. Anything else stays pending or cancels through readiness.
 */
function explicitEndSalvageEligible(
  request: SessionFinalizationRequestV2,
  record: HookProducerStateRecordV2,
  events: EventV2[],
): boolean {
  if (record.state.delegations.length > 0) return false;
  if (record.state.current_turn_id) return false;
  if (record.state.spans.length === 0) return false;
  const allowedSpans = new Set(request.allowed_open_span_ids ?? []);
  if (record.state.spans.some(({ span_id }) => !allowedSpans.has(span_id))) return false;
  if (!request.observation_event_id) return false;
  const observationIndex = events.findIndex(
    (event) => event.event_id === request.observation_event_id,
  );
  if (observationIndex < 0) return false;
  const later = laterGenerationEvents(events, observationIndex, request.generation_id);
  if (later.some(isNativeNewWork)) return false;
  if (!request.requested_turn_id) return true;
  return later.some(
    (event) =>
      event.event_type === "turn.completed" &&
      "turn_id" in event.scope &&
      event.scope.turn_id === request.requested_turn_id,
  );
}

function buildObservationEvent(
  coordRoot: string,
  record: HookProducerStateRecordV2,
  request: SessionFinalizationRequestV2,
  input: RequestInput,
): EventV2 {
  const route = input.route;
  const rootId = (
    route.mode === "candidate" ? readActiveLedgerV2(coordRoot) : readLedgerV2(coordRoot)
  ).events.find(({ event }) => event.event_type === "ledger.genesis")?.event.scope
    .root_id as `root_${string}`;
  const context = fingerprintContextV2(
    coordRoot,
    rootId,
    record.state.generation_id,
    record.state.privacy_epoch_id,
  );
  const event = buildEventV2("lifecycle.sweep_observed", {
    producer: {
      producer_id: "prd_agent-finalizer",
      boot_id: `boot_${randomUUID()}`,
      sequence: 1,
      component: "agent-coord",
      build_id: route.build_id,
      platform: livePlatformV2(),
    },
    scope: {
      root_id: rootId,
      instance_id: record.state.instance_id,
      session_id: record.state.session_id,
      generation_id: record.state.generation_id,
    },
    attestation_id: record.state.attestation_id,
    links: {
      caused_by: [record.state.last_event_id, input.cause].filter(Boolean) as `evt_${string}`[],
    },
    provenance: {
      source_event: `agent-coord.session-finalizer.${request.trigger}`,
      attestation: "derived",
      confidence: request.trigger === "verified_archive" ? "exact" : "medium",
      source_record_id: normalizeNativeIdV2(
        context,
        "agent-coord.session-finalization-request",
        request.request_id,
      ),
      attribution: {
        method: "explicit_argument",
        state: "verified",
        observer_instance_id: record.state.instance_id,
        subject_instance_id: record.state.instance_id,
      },
    },
    observed_at: request.observed_at,
    monotonic_ns: process.hrtime.bigint().toString(),
    payload: {
      subject_instance_id: record.state.instance_id,
      observation: request.trigger,
      provisional: true,
      age_ms: Math.max(0, Math.floor(input.ageMs)),
    },
  }) as EventV2;
  assertEventV2(event);
  return event;
}

function cancelPendingRequests(
  coordRoot: string,
  generationId: `gen_${string}`,
  trigger: SessionFinalizationTriggerV2,
  at: string,
): number {
  let cancelled = 0;
  for (const request of listRequests(coordRoot)) {
    if (
      request.status === "pending" &&
      request.generation_id === generationId &&
      request.trigger === trigger
    ) {
      cancelRequest(coordRoot, request, at);
      cancelled += 1;
    }
  }
  return cancelled;
}

function cancelRequest(coordRoot: string, request: SessionFinalizationRequestV2, at: string): void {
  writeRequest(coordRoot, { ...request, status: "cancelled", cancelled_at: at });
}

function completeRequest(
  coordRoot: string,
  request: SessionFinalizationRequestV2,
  eventId?: `evt_${string}`,
): void {
  writeRequest(coordRoot, {
    ...request,
    status: "completed",
    completed_at: new Date().toISOString(),
    ...(eventId ? { terminal_event_id: eventId } : {}),
  });
}

function requestDirectory(coordRoot: string): string {
  return join(resolve(coordRoot), EVENT_V2_LEDGER_RELATIVE_ROOT, "finalization", "requests");
}

function requestPath(coordRoot: string, requestId: string): string {
  return join(requestDirectory(coordRoot), `${requestId}.json`);
}

export function listSessionFinalizationRequestsV2(
  coordRoot: string,
): SessionFinalizationRequestV2[] {
  return listRequests(coordRoot);
}

function listRequests(coordRoot: string): SessionFinalizationRequestV2[] {
  const directory = requestDirectory(coordRoot);
  if (!existsSync(directory)) return [];
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("V2 session finalization request directory is unsafe");
  }
  return readdirSync(directory)
    .filter((name) => /^sfr_[0-9a-f-]+\.json$/.test(name))
    .map((name) => readRequest(join(directory, name)))
    .sort((left, right) => left.observed_at.localeCompare(right.observed_at));
}

function readRequest(path: string): SessionFinalizationRequestV2 {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("V2 session finalization request is unsafe");
  }
  const request = JSON.parse(readFileSync(path, "utf8")) as SessionFinalizationRequestV2;
  if (
    request.format !== REQUEST_FORMAT ||
    request.format_version !== REQUEST_VERSION ||
    !/^sfr_[0-9a-f-]+$/.test(request.request_id) ||
    !/^inst_[a-zA-Z0-9._-]+$/.test(request.instance_id) ||
    !/^gen_[0-9a-f-]+$/.test(request.generation_id) ||
    !["pending", "cancelled", "completed"].includes(request.status)
  )
    throw new Error("V2 session finalization request is invalid");
  return request;
}

function writeRequest(
  coordRoot: string,
  request: SessionFinalizationRequestV2,
  create = false,
): void {
  const directory = requestDirectory(coordRoot);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = requestPath(coordRoot, request.request_id);
  if (create && existsSync(path)) throw new Error("V2 finalization request already exists");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(request)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    fsyncParentDirectory(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function lastEventsByGeneration(events: EventV2[]): Map<string, EventV2> {
  const out = new Map<string, EventV2>();
  for (const event of events) {
    if ("generation_id" in event.scope) out.set(event.scope.generation_id, event);
  }
  return out;
}

function addSeconds(timestamp: string, seconds: number): string {
  return new Date(Date.parse(timestamp) + seconds * 1_000).toISOString();
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireFinalizationReconcileLease(coordRoot: string) {
  return acquireNoClobberLease({
    path: join(
      resolve(coordRoot),
      EVENT_V2_LEDGER_RELATIVE_ROOT,
      "finalization",
      "reconcile-lease",
    ),
    scope: "event-v2-session-finalization-reconcile",
    authoritySha256: createHash("sha256").update(resolve(coordRoot)).digest("hex"),
    staleAfterMs: 30_000,
    validateStaleOwner: (owner) => owner.host === hostname() && !pidIsAlive(owner.pid),
  });
}
