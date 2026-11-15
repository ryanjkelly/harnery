import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { processAlive } from "../../lib/process-alive.ts";
import type { Adapter } from "../adapter.ts";
import { buildEventV3 } from "../events/v3/builder.ts";
import { fingerprintV3 } from "../events/v3/canonical.ts";
import type { EventV3 } from "../events/v3/contract.ts";
import { readEventV3ControlState } from "../events/v3/control.ts";
import { projectCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import {
  DELEGATION_LINK_SOURCE_EVENT,
  type DelegationCompletionPlanV3,
  type DelegationLinkPlanV3,
  planDelegationLinksV3,
} from "../events/v3/delegation-keys.ts";
import { fingerprintContextV3 } from "../events/v3/fingerprint-keys.ts";
import { delegationIdV3, spanIdV3 } from "../events/v3/ids.ts";
import { livePlatformV3, resolveLiveEventLedgerRouteV3 } from "../events/v3/live-routing.ts";
import { listHookProducerStateRecordsV3 } from "../events/v3/producers/recorder.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import { assertEventV3 } from "../events/v3/validate.ts";
import { EVENT_V3_LEDGER_RELATIVE_ROOT, writeEventV3 } from "../events/v3/writer.ts";
import { acquireNoClobberLease } from "../storage/no-clobber-lease.ts";
import {
  delegationKeyFromEnv,
  delegationKeyFromToolResult,
} from "./delegation-surface/registry.ts";
import type { DelegationKeyObservation } from "./delegation-surface/types.ts";

/**
 * Client-delegated worker links (ADR 0268).
 *
 * Each side records only a fingerprint of the opaque key its client exposes:
 * the parent from its delegate tool's result, the child from its environment.
 * A later pass joins equal keys and writes the existing `agent.started` event
 * in the parent's scope, so the rest of Harnery reads a delegated worker
 * exactly as it reads a native subagent. When the worker ends, or declares
 * lifecycle done and goes idle, the same pass writes `agent.completed`, which
 * the session finalizer already acts on.
 *
 * Every entry point fails open: an unexpected payload, a missing ledger, or a
 * write error records nothing and never blocks the tool or the session.
 */

const PRODUCER_ID = "prd_agent-delegation-link" as const;
const KEY_DOMAIN = "delegation-key";

export type DelegationLinkOutcomeV3 =
  | { state: "recorded"; event_id: string }
  | { state: "skipped"; reason: string };

function route(coordRoot: string) {
  const resolved = resolveLiveEventLedgerRouteV3(coordRoot);
  return resolved.state === "v3" ? resolved : undefined;
}

function producer(buildId: `build_${string}`) {
  return {
    producer_id: PRODUCER_ID,
    boot_id: `boot_${randomUUID()}` as `boot_${string}`,
    sequence: 1,
    component: "agent-coord" as const,
    build_id: buildId,
    platform: livePlatformV3(),
  };
}

/**
 * Record one side of a delegation for the live generation `generationId`.
 * Writes nothing when the ledger is not live or the generation is unknown.
 */
export function recordDelegationKeyV3(input: {
  coordRoot: string;
  generationId: `gen_${string}`;
  side: "parent" | "child";
  observation: DelegationKeyObservation;
}): DelegationLinkOutcomeV3 {
  try {
    const live = route(input.coordRoot);
    if (!live) return { state: "skipped", reason: "ledger_not_live" };
    const control = readEventV3ControlState(input.coordRoot);
    if (control.state !== "candidate" && control.state !== "active") {
      return { state: "skipped", reason: "ledger_not_live" };
    }
    const record = listHookProducerStateRecordsV3(input.coordRoot).find(
      ({ state }) => state.generation_id === input.generationId,
    );
    if (!record?.state.last_event_id) return { state: "skipped", reason: "generation_unknown" };
    const rootId = control.genesis.event.scope.root_id as `root_${string}`;
    const context = fingerprintContextV3(
      input.coordRoot,
      rootId,
      undefined,
      control.genesis.profile.privacy_key_epoch,
    );
    const event = buildEventV3("agent.delegation_keyed", {
      producer: producer(live.build_id),
      scope: {
        root_id: rootId,
        instance_id: record.state.instance_id,
        session_id: record.state.session_id,
        generation_id: record.state.generation_id,
      },
      attestation_id: record.state.attestation_id,
      links: { caused_by: [record.state.last_event_id], span_id: spanIdV3() },
      provenance: {
        source_event: `agent-coord.delegation-key.${input.side}`,
        attestation: "derived",
        confidence: "exact",
        attribution: {
          method: input.side === "parent" ? "native_payload" : "session_env",
          state: "verified",
          subject_instance_id: record.state.instance_id,
        },
      },
      monotonic_ns: process.hrtime.bigint().toString(),
      payload: {
        side: input.side,
        surface: input.observation.surface,
        delegation_key: fingerprintV3(
          context,
          KEY_DOMAIN,
          { surface: input.observation.surface, key: input.observation.key },
          "root",
        ),
      },
    } as never) as EventV3;
    assertEventV3(event);
    const durability = writeEventV3(input.coordRoot, event, {
      expectedGenesisId: live.genesis_id,
    });
    if (durability.state === "epoch_replaced" || durability.state === "set_aside") {
      return { state: "skipped", reason: durability.state };
    }
    return { state: "recorded", event_id: event.event_id };
  } catch {
    return { state: "skipped", reason: "record_failed" };
  }
}

/** Parent side: a finished delegate tool call. Records and links; never throws. */
export function observeDelegateToolResultV3(input: {
  coordRoot: string;
  generationId: `gen_${string}` | undefined;
  toolName: string | undefined;
  toolResponse: unknown;
}): DelegationLinkOutcomeV3 {
  try {
    if (!input.generationId) return { state: "skipped", reason: "generation_unknown" };
    const observation = delegationKeyFromToolResult(input.toolName, input.toolResponse);
    if (!observation) return { state: "skipped", reason: "not_a_delegation" };
    const recorded = recordDelegationKeyV3({
      coordRoot: input.coordRoot,
      generationId: input.generationId,
      side: "parent",
      observation,
    });
    if (recorded.state === "recorded") linkDelegatedWorkersV3(input.coordRoot);
    return recorded;
  } catch {
    return { state: "skipped", reason: "observe_failed" };
  }
}

/** Child side: a session start whose environment names a delegation. Never throws. */
export function observeDelegatedChildStartV3(input: {
  coordRoot: string;
  generationId: `gen_${string}` | undefined;
  adapter: Adapter | null;
  env?: Readonly<Record<string, string | undefined>>;
}): DelegationLinkOutcomeV3 {
  try {
    if (!input.generationId) return { state: "skipped", reason: "generation_unknown" };
    const observation = delegationKeyFromEnv(input.env ?? process.env, input.adapter);
    if (!observation) return { state: "skipped", reason: "not_a_delegated_child" };
    const recorded = recordDelegationKeyV3({
      coordRoot: input.coordRoot,
      generationId: input.generationId,
      side: "child",
      observation,
    });
    if (recorded.state === "recorded") linkDelegatedWorkersV3(input.coordRoot);
    return recorded;
  } catch {
    return { state: "skipped", reason: "observe_failed" };
  }
}

export interface LinkDelegatedWorkersResultV3 {
  linked: number;
  completed: number;
  diagnostics: string[];
}

function acquireLinkLease(coordRoot: string) {
  return acquireNoClobberLease({
    path: join(resolve(coordRoot), EVENT_V3_LEDGER_RELATIVE_ROOT, "delegation-link", "lease"),
    scope: "event-v3-delegation-link",
    authoritySha256: createHash("sha256").update(resolve(coordRoot)).digest("hex"),
    staleAfterMs: 30_000,
    validateStaleOwner: (owner) => owner.host === hostname() && !processAlive(owner.pid),
  });
}

/**
 * Join recorded keys into delegations and complete finished ones. Safe to run
 * from any process at any time: a lease serializes writers and the plan is
 * recomputed from the ledger, so a repeated run writes nothing new.
 */
export function linkDelegatedWorkersV3(coordRoot: string): LinkDelegatedWorkersResultV3 {
  const result: LinkDelegatedWorkersResultV3 = { linked: 0, completed: 0, diagnostics: [] };
  const live = route(coordRoot);
  if (!live) {
    result.diagnostics.push("ledger_not_live");
    return result;
  }
  let lease: ReturnType<typeof acquireNoClobberLease>;
  try {
    lease = acquireLinkLease(coordRoot);
  } catch {
    result.diagnostics.push("delegation_link_busy");
    return result;
  }
  try {
    const read =
      live.mode === "candidate"
        ? readLedgerV3(coordRoot, { authority: "candidate" })
        : readLedgerV3(coordRoot);
    if (!read.complete || read.diagnostics.length > 0) {
      result.diagnostics.push("ledger_not_authority_safe");
      return result;
    }
    const events = read.events.map(({ event }) => event);
    const plan = planDelegationLinksV3(events, projectCoordinationViewV3(read));
    if (plan.links.length === 0 && plan.completions.length === 0) return result;
    const starts = new Map<string, Extract<EventV3, { event_type: "session.started" }>>();
    const byId = new Map<string, EventV3>();
    for (const event of events) {
      byId.set(event.event_id, event);
      if (event.event_type === "session.started" && "generation_id" in event.scope) {
        starts.set(event.scope.generation_id, event);
      }
    }
    for (const link of plan.links) {
      const event = linkEvent(live.build_id, link, starts, byId);
      if (!event) continue;
      writeEventV3(coordRoot, event, { expectedGenesisId: live.genesis_id });
      result.linked += 1;
    }
    for (const completion of plan.completions) {
      const event = completionEvent(live.build_id, completion, starts, byId);
      if (!event) continue;
      writeEventV3(coordRoot, event, { expectedGenesisId: live.genesis_id });
      result.completed += 1;
    }
  } catch (error) {
    result.diagnostics.push(
      `delegation_link_failed:${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    lease.release();
  }
  return result;
}

function parentScope(start: Extract<EventV3, { event_type: "session.started" }>) {
  const scope = start.scope as {
    root_id: string;
    instance_id: string;
    session_id: string;
    generation_id: string;
  };
  return {
    root_id: scope.root_id,
    instance_id: scope.instance_id,
    session_id: scope.session_id,
    generation_id: scope.generation_id,
  };
}

function provenance(
  start: Extract<EventV3, { event_type: "session.started" }>,
  child: Extract<EventV3, { event_type: "session.started" }>,
) {
  return {
    source_event: DELEGATION_LINK_SOURCE_EVENT,
    attestation: "derived" as const,
    confidence: "exact" as const,
    attribution: {
      method: "explicit_argument" as const,
      state: "verified" as const,
      observer_instance_id: child.scope.instance_id,
      subject_instance_id: start.scope.instance_id,
    },
  };
}

function linkEvent(
  buildId: `build_${string}`,
  link: DelegationLinkPlanV3,
  starts: Map<string, Extract<EventV3, { event_type: "session.started" }>>,
  byId: Map<string, EventV3>,
): EventV3 | undefined {
  const parent = starts.get(link.parent_generation_id);
  const child = starts.get(link.child_generation_id);
  const keyed = byId.get(link.parent_keyed_event_id);
  const parentSpan = (keyed?.links as { span_id?: `span_${string}` } | undefined)?.span_id;
  if (!parent || !child || !parentSpan) return undefined;
  const event = buildEventV3("agent.started", {
    producer: producer(buildId),
    scope: parentScope(parent),
    attestation_id: parent.attestation_id,
    links: {
      caused_by: link.caused_by,
      span_id: spanIdV3(),
      parent_span_id: parentSpan,
      delegation_id: delegationIdV3(),
      parent_generation_id: link.parent_generation_id,
    },
    provenance: provenance(parent, child),
    monotonic_ns: process.hrtime.bigint().toString(),
    payload: {
      delegation_id: "",
      child_generation_id: link.child_generation_id,
      role: `delegated:${link.surface}`,
    },
  } as never) as EventV3 & {
    links: { delegation_id: string };
    payload: { delegation_id: string };
  };
  event.payload.delegation_id = event.links.delegation_id;
  assertEventV3(event);
  return event;
}

function completionEvent(
  buildId: `build_${string}`,
  completion: DelegationCompletionPlanV3,
  starts: Map<string, Extract<EventV3, { event_type: "session.started" }>>,
  byId: Map<string, EventV3>,
): EventV3 | undefined {
  const parent = starts.get(completion.parent_generation_id);
  const child = starts.get(completion.child_generation_id);
  const started = byId.get(completion.started_event_id) as
    | Extract<EventV3, { event_type: "agent.started" }>
    | undefined;
  if (!parent || !child || !started) return undefined;
  const span = started.links as { span_id: `span_${string}`; parent_span_id: `span_${string}` };
  const openedAt = started.time.observed_at;
  const now = new Date();
  const event = buildEventV3("agent.completed", {
    producer: producer(buildId),
    scope: parentScope(parent),
    attestation_id: parent.attestation_id,
    links: {
      caused_by: [completion.started_event_id, completion.cause_event_id].filter(
        (id, index, all) => all.indexOf(id) === index,
      ),
      span_id: span.span_id,
      parent_span_id: span.parent_span_id,
      delegation_id: completion.delegation_id,
      parent_generation_id: completion.parent_generation_id,
    },
    provenance: {
      ...provenance(parent, child),
      source_event: DELEGATION_LINK_SOURCE_EVENT,
    },
    observed_at: now.toISOString(),
    recorded_at: now.toISOString(),
    monotonic_ns: process.hrtime.bigint().toString(),
    payload: {
      delegation_id: completion.delegation_id,
      child_generation_id: completion.child_generation_id,
      outcome: completion.outcome,
      span: {
        span_id: span.span_id,
        parent_span_id: span.parent_span_id,
        opened_at: openedAt,
        duration_ms: {
          state: "observed",
          value: Math.max(0, now.getTime() - Date.parse(openedAt)),
          attestation: "derived",
          confidence: "medium",
        },
        open_event_id: completion.started_event_id,
      },
    },
  } as never) as EventV3;
  assertEventV3(event);
  return event;
}

/**
 * The hook entry point: a session start may carry the child side, a finished
 * tool call may carry the parent side. Anything else returns at once.
 */
export function observeHookDelegationV3(input: {
  coordRoot: string;
  eventType: string;
  eventName: string;
  generationId: `gen_${string}` | undefined;
  adapter: Adapter | null;
  toolName: string | undefined;
  toolResponse: unknown;
}): DelegationLinkOutcomeV3 {
  if (input.eventType === "session.started") {
    return observeDelegatedChildStartV3({
      coordRoot: input.coordRoot,
      generationId: input.generationId,
      adapter: input.adapter,
    });
  }
  if (input.eventType === "tool.completed" && input.eventName === "post-tool-use") {
    return observeDelegateToolResultV3({
      coordRoot: input.coordRoot,
      generationId: input.generationId,
      toolName: input.toolName,
      toolResponse: input.toolResponse,
    });
  }
  return { state: "skipped", reason: "not_a_delegation_signal" };
}
