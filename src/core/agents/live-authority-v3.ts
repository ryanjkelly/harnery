import { randomUUID } from "node:crypto";
import type { Adapter } from "../adapter.ts";
import type { AuthorityMutationV3 } from "../events/v3/authority-outbox.ts";
import { canonicalJsonV3, sha256V3 } from "../events/v3/canonical.ts";
import type { EventV3WriteMode } from "../events/v3/control.ts";
import {
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../events/v3/coordination-view.ts";
import {
  LIVE_HOOK_V3_PRODUCER_ID,
  liveInstanceIdV3,
  livePlatformV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import type {
  CoordinationAuthoritySignalV3,
  CoordinationObservationBySignalV3,
} from "../events/v3/producers/coordination.ts";
import {
  type RecordCoordinationAuthorityV3Result,
  recordCoordinationAuthorityV3,
} from "../events/v3/producers/coordination-recorder.ts";
import {
  readTerminalHookProducerStateV3,
  recordHookSignalV3,
} from "../events/v3/producers/recorder.ts";
import { canonicalClaimPath } from "./claim-path.ts";
import {
  acquireClaim,
  type Heartbeat,
  readHeartbeat,
  releaseClaim,
  setIdentityCache,
  setLifecycleCache,
  setTask,
} from "./state/heartbeat-writer.ts";
import {
  ensureLiveCoordinationHeartbeat,
  liveCoordinationAdapterV3,
} from "./state/live-coordination-view.ts";
import { recordNameAssumption } from "./state/names.ts";

export const LIVE_COORDINATION_V3_PRODUCER_ID = "prd_agent-coord" as const;

export class LiveCoordinationAuthorityV3Error extends Error {
  constructor(public readonly reason: string) {
    super(`event_v3_coordination_authority:${reason}`);
    this.name = "LiveCoordinationAuthorityV3Error";
  }
}

export type LiveCoordinationAuthorityV3Result =
  | { state: "unchanged" }
  | { state: "recorded"; result: RecordCoordinationAuthorityV3Result };

export interface ReopenedLiveCoordinationGenerationV3 {
  state: "reopened";
  adapter: Adapter;
  prior_generation_id: `gen_${string}`;
  generation_id: `gen_${string}`;
}

interface LiveAuthorityBaseV3 {
  coordRoot: string;
  owner: string;
  subject?: string;
  nativeSessionId: string;
  adapter: Adapter;
  observationId?: string;
}

/**
 * Open a fresh derived generation for a human-facing session that is executing
 * again after an authoritative terminal. The terminal generation is never
 * changed or reused.
 */
export function reopenLiveCoordinationGenerationV3(input: {
  coordRoot: string;
  owner: string;
  nativeSessionId: string;
}): ReopenedLiveCoordinationGenerationV3 {
  const route = resolveLiveEventLedgerRouteV3(input.coordRoot);
  if (route.state === "blocked") throw new LiveCoordinationAuthorityV3Error(route.reason);
  const instanceId = liveInstanceIdV3(input.owner);
  const terminal = readTerminalHookProducerStateV3(
    input.coordRoot,
    input.nativeSessionId,
    instanceId,
  );
  if (!terminal) {
    throw new LiveCoordinationAuthorityV3Error("terminal_generation_identity_missing");
  }
  const view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(input.coordRoot));
  const terminalView = view.terminal_generations[terminal.generation_id];
  if (!terminalView || terminalView.instance_id !== instanceId) {
    throw new LiveCoordinationAuthorityV3Error("terminal_generation_authority_missing");
  }
  if (terminalView.parent_generation_id || terminalView.delegation_id || terminalView.workflow_id) {
    throw new LiveCoordinationAuthorityV3Error("lifecycle_not_human_facing");
  }
  const reopened = recordHookSignalV3({
    coordRoot: input.coordRoot,
    mode: route.mode,
    signal: "session-start",
    payload: { raw: {}, session_id: input.nativeSessionId },
    adapter: terminal.adapter,
    instance_id: instanceId,
    producer_id: LIVE_HOOK_V3_PRODUCER_ID,
    build_id: route.build_id,
    platform: livePlatformV3(),
    session_start_derivation: "approved_lifecycle_reopen",
  });
  if (reopened.state !== "recorded" && reopened.state !== "already_started") {
    throw new LiveCoordinationAuthorityV3Error(`generation_reopen_failed:${reopened.state}`);
  }
  const heartbeat = ensureLiveCoordinationHeartbeat(
    input.coordRoot,
    input.owner,
    input.nativeSessionId,
    terminal.adapter,
  );
  if (!heartbeat) {
    throw new LiveCoordinationAuthorityV3Error("reopened_generation_materialization_failed");
  }
  return {
    state: "reopened",
    adapter: terminal.adapter,
    prior_generation_id: terminal.generation_id,
    generation_id: heartbeat.v3_generation_id as `gen_${string}`,
  };
}

export function recordLiveTaskChangeV3(
  input: LiveAuthorityBaseV3 & { task: string },
): LiveCoordinationAuthorityV3Result {
  liveCoordinationWriteModeV3(input.coordRoot);
  const before = requireHeartbeat(input, input.subject ?? input.owner);
  const cleared = input.task.length === 0;
  const desired = {
    ...before,
    task: undefined,
    v3_task_state: cleared ? ("cleared" as const) : ("set" as const),
  };
  // A task declaration is also per-turn ritual evidence. Record repeated
  // declarations, including cleared -> cleared, even when the disposable view
  // does not change. Otherwise a conversational Cursor remediation turn can
  // run `set-task ""` exactly as instructed and still loop forever because no
  // coord.task_changed event reaches the verdict window.
  return recordLiveAuthority(
    input,
    "task-changed",
    {
      native_observation_id: input.observationId ?? `task-${randomUUID()}`,
      state: cleared ? "cleared" : "set",
      ...(cleared ? {} : { task: input.task }),
    },
    before,
    desired,
    () => {
      // The canonical event records only the privacy-safe set/cleared state.
      // Task prose and its operator-facing suggested name live exclusively in
      // this generation-bound disposable cache; they never enter the ledger.
      if (!setTask(input.coordRoot, input.subject ?? input.owner, input.task)) {
        throw new LiveCoordinationAuthorityV3Error("task_materialization_failed");
      }
    },
  );
}

export function recordLiveLifecycleChangeV3(
  input: LiveAuthorityBaseV3 & {
    state: "active" | "blocked" | "done";
    reason?: string;
    suggestedSessionName?: string;
    observedAt?: string;
  },
): LiveCoordinationAuthorityV3Result {
  liveCoordinationWriteModeV3(input.coordRoot);
  const subject = input.subject ?? input.owner;
  const before = requireHeartbeat(input, subject);
  const desired: Heartbeat = {
    ...before,
    task_state: input.state,
    task_state_reason: input.state === "active" ? undefined : input.reason,
    ...(input.suggestedSessionName ? { suggested_session_name: input.suggestedSessionName } : {}),
  };
  if (authorityStateDigest(before) === authorityStateDigest(desired)) return { state: "unchanged" };
  return recordLiveAuthority(
    input,
    "lifecycle-changed",
    {
      native_observation_id: input.observationId ?? `lifecycle-${randomUUID()}`,
      state: input.state,
      ...(input.reason ? { reason_code: `operator_${input.state}` } : {}),
    },
    before,
    desired,
    () => {
      if (
        !setLifecycleCache(
          input.coordRoot,
          subject,
          input.state,
          input.reason,
          input.suggestedSessionName,
        )
      ) {
        throw new LiveCoordinationAuthorityV3Error("lifecycle_materialization_failed");
      }
    },
  );
}

export function recordLiveClaimChangeV3(
  input: LiveAuthorityBaseV3 & {
    operation: "acquired" | "released";
    path: string;
    access?: "read" | "write";
  },
): LiveCoordinationAuthorityV3Result {
  liveCoordinationWriteModeV3(input.coordRoot);
  const subject = input.subject ?? input.owner;
  const before = requireHeartbeat(input, subject);
  const canonical = canonicalClaimPath(input.coordRoot, input.path);
  const desiredFiles =
    input.operation === "acquired"
      ? [
          ...new Set([
            ...(before.files_touched ?? []).map((path) =>
              canonicalClaimPath(input.coordRoot, path),
            ),
            canonical,
          ]),
        ].sort()
      : (before.files_touched ?? []).filter(
          (path) => canonicalClaimPath(input.coordRoot, path) !== canonical,
        );
  const desired: Heartbeat = { ...before, files_touched: desiredFiles };
  if (authorityStateDigest(before) === authorityStateDigest(desired)) return { state: "unchanged" };
  return recordLiveAuthority(
    input,
    "claim-changed",
    {
      native_observation_id: input.observationId ?? `claim-${randomUUID()}`,
      operation: input.operation,
      target: canonical,
      access: input.access ?? "write",
    },
    before,
    desired,
    () => {
      const result =
        input.operation === "acquired"
          ? acquireClaim(input.coordRoot, subject, canonical)
          : releaseClaim(input.coordRoot, subject, canonical);
      if (!result) throw new LiveCoordinationAuthorityV3Error("claim_materialization_failed");
    },
  );
}

export function recordLiveIdentityChangeV3(
  input: LiveAuthorityBaseV3 & { name: string; identityId: string },
): LiveCoordinationAuthorityV3Result {
  liveCoordinationWriteModeV3(input.coordRoot);
  const subject = input.subject ?? input.owner;
  const before = requireHeartbeat(input, subject);
  const desired: Heartbeat = { ...before, name: input.name, agent_id: input.identityId };
  if (authorityStateDigest(before) === authorityStateDigest(desired)) return { state: "unchanged" };
  return recordLiveAuthority(
    input,
    "identity-attested",
    {
      native_observation_id: input.observationId ?? `identity-${randomUUID()}`,
      identity_id: input.identityId,
      method: "operator_assumption",
    },
    before,
    desired,
    () => {
      recordNameAssumption(input.coordRoot, subject, input.name, input.identityId, "session");
      if (!setIdentityCache(input.coordRoot, subject, input.name, input.identityId)) {
        throw new LiveCoordinationAuthorityV3Error("identity_materialization_failed");
      }
    },
  );
}

function recordLiveAuthority<S extends CoordinationAuthoritySignalV3>(
  input: LiveAuthorityBaseV3,
  signal: S,
  observation: CoordinationObservationBySignalV3[S],
  expected: Heartbeat,
  desired: Heartbeat,
  apply: () => void,
): LiveCoordinationAuthorityV3Result {
  const route = resolveLiveEventLedgerRouteV3(input.coordRoot);
  if (route.state === "blocked") throw new LiveCoordinationAuthorityV3Error(route.reason);
  const adapter = liveCoordinationAdapterV3(input.coordRoot, input.owner);
  if (!adapter) throw new LiveCoordinationAuthorityV3Error("actor_generation_missing");
  const subject = input.subject ?? input.owner;
  const result = recordAuthority({
    coordRoot: input.coordRoot,
    mode: route.mode,
    signal,
    observation,
    adapter,
    native_actor_session_id: input.nativeSessionId,
    actor_instance_id: liveInstanceIdV3(input.owner),
    subject_instance_id: liveInstanceIdV3(subject),
    producer_id: LIVE_COORDINATION_V3_PRODUCER_ID,
    build_id: route.build_id,
    platform: livePlatformV3(),
    expected_prior_state_digest: authorityStateDigest(expected),
    desired_state_digest: authorityStateDigest(desired),
    reconciler: {
      readStateDigest: () => {
        const heartbeat = readHeartbeat(input.coordRoot, subject);
        if (!heartbeat || heartbeat.v3_generation_id !== expected.v3_generation_id) {
          throw new LiveCoordinationAuthorityV3Error(`heartbeat_generation_mismatch:${subject}`);
        }
        return authorityStateDigest(heartbeat);
      },
      apply: (_mutation: AuthorityMutationV3) => apply(),
    },
  });
  if (result.state === "gate_closed" || result.state === "generation_unavailable") {
    throw new LiveCoordinationAuthorityV3Error(`${result.state}:${result.reason}`);
  }
  if (result.state === "pending_transaction") {
    throw new LiveCoordinationAuthorityV3Error(`pending_transaction:${result.transaction_id}`);
  }
  return { state: "recorded", result };
}

function recordAuthority<S extends CoordinationAuthoritySignalV3>(
  input: Parameters<typeof recordCoordinationAuthorityV3<S>>[0],
): RecordCoordinationAuthorityV3Result {
  return recordCoordinationAuthorityV3(input);
}

export function liveCoordinationWriteModeV3(coordRoot: string): EventV3WriteMode {
  const route = resolveLiveEventLedgerRouteV3(coordRoot);
  if (route.state === "blocked") throw new LiveCoordinationAuthorityV3Error(route.reason);
  return route.mode;
}

function requireHeartbeat(input: LiveAuthorityBaseV3, owner: string): Heartbeat {
  const heartbeat = ensureLiveCoordinationHeartbeat(
    input.coordRoot,
    owner,
    owner === input.owner ? input.nativeSessionId : owner,
    input.adapter,
  );
  if (!heartbeat) throw new LiveCoordinationAuthorityV3Error(`heartbeat_missing:${owner}`);
  return heartbeat;
}

function authorityStateDigest(heartbeat: Heartbeat): `sha256:${string}` {
  return sha256V3(
    canonicalJsonV3({
      instance_id: heartbeat.v3_instance_id ?? heartbeat.instance_id,
      generation_id: heartbeat.v3_generation_id ?? null,
      task_state: heartbeat.v3_task_state ?? (heartbeat.task ? "set" : "cleared"),
      lifecycle_state: heartbeat.task_state ?? "active",
      task_state_reason: heartbeat.task_state_reason ?? null,
      files_touched: [...new Set(heartbeat.files_touched ?? [])].sort(),
      identity_id: heartbeat.agent_id ?? null,
      display_name: heartbeat.name ?? null,
    }),
  );
}
