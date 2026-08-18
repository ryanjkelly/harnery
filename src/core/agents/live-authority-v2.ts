import { randomUUID } from "node:crypto";
import type { Adapter } from "../adapter.ts";
import type { AuthorityMutationV2 } from "../events/v2/authority-outbox.ts";
import { canonicalJsonV2, sha256V2 } from "../events/v2/canonical.ts";
import type { EventV2WriteMode } from "../events/v2/control.ts";
import {
  liveInstanceIdV2,
  livePlatformV2,
  resolveLiveEventLedgerRouteV2,
} from "../events/v2/live-routing.ts";
import type {
  CoordinationAuthoritySignalV2,
  CoordinationObservationBySignalV2,
} from "../events/v2/producers/coordination.ts";
import {
  type RecordCoordinationAuthorityV2Result,
  recordCoordinationAuthorityV2,
} from "../events/v2/producers/coordination-recorder.ts";
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
  liveCoordinationAdapterV2,
} from "./state/live-coordination-view.ts";
import { recordNameAssumption } from "./state/names.ts";

export const LIVE_COORDINATION_V2_PRODUCER_ID = "prd_agent-coord" as const;

export class LiveCoordinationAuthorityV2Error extends Error {
  constructor(public readonly reason: string) {
    super(`event_v2_coordination_authority:${reason}`);
    this.name = "LiveCoordinationAuthorityV2Error";
  }
}

export type LiveCoordinationAuthorityV2Result =
  | { state: "unchanged" }
  | { state: "recorded"; result: RecordCoordinationAuthorityV2Result };

interface LiveAuthorityBaseV2 {
  coordRoot: string;
  owner: string;
  subject?: string;
  nativeSessionId: string;
  adapter: Adapter;
  observationId?: string;
}

export function recordLiveTaskChangeV2(
  input: LiveAuthorityBaseV2 & { task: string },
): LiveCoordinationAuthorityV2Result {
  liveCoordinationWriteModeV2(input.coordRoot);
  const before = requireHeartbeat(input, input.subject ?? input.owner);
  const cleared = input.task.length === 0;
  const desired = {
    ...before,
    task: undefined,
    v2_task_state: cleared ? ("cleared" as const) : ("set" as const),
  };
  if (cleared && authorityStateDigest(before) === authorityStateDigest(desired)) {
    if (!setTask(input.coordRoot, input.subject ?? input.owner, input.task)) {
      throw new LiveCoordinationAuthorityV2Error("task_materialization_failed");
    }
    return { state: "unchanged" };
  }
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
        throw new LiveCoordinationAuthorityV2Error("task_materialization_failed");
      }
    },
  );
}

export function recordLiveLifecycleChangeV2(
  input: LiveAuthorityBaseV2 & {
    state: "active" | "blocked" | "done";
    reason?: string;
    suggestedSessionName?: string;
    observedAt?: string;
  },
): LiveCoordinationAuthorityV2Result {
  liveCoordinationWriteModeV2(input.coordRoot);
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
        throw new LiveCoordinationAuthorityV2Error("lifecycle_materialization_failed");
      }
    },
  );
}

export function recordLiveClaimChangeV2(
  input: LiveAuthorityBaseV2 & {
    operation: "acquired" | "released";
    path: string;
    access?: "read" | "write";
  },
): LiveCoordinationAuthorityV2Result {
  liveCoordinationWriteModeV2(input.coordRoot);
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
      if (!result) throw new LiveCoordinationAuthorityV2Error("claim_materialization_failed");
    },
  );
}

export function recordLiveIdentityChangeV2(
  input: LiveAuthorityBaseV2 & { name: string; identityId: string },
): LiveCoordinationAuthorityV2Result {
  liveCoordinationWriteModeV2(input.coordRoot);
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
        throw new LiveCoordinationAuthorityV2Error("identity_materialization_failed");
      }
    },
  );
}

function recordLiveAuthority<S extends CoordinationAuthoritySignalV2>(
  input: LiveAuthorityBaseV2,
  signal: S,
  observation: CoordinationObservationBySignalV2[S],
  expected: Heartbeat,
  desired: Heartbeat,
  apply: () => void,
): LiveCoordinationAuthorityV2Result {
  const route = resolveLiveEventLedgerRouteV2(input.coordRoot);
  if (route.state === "blocked") throw new LiveCoordinationAuthorityV2Error(route.reason);
  const adapter = liveCoordinationAdapterV2(input.coordRoot, input.owner);
  if (!adapter) throw new LiveCoordinationAuthorityV2Error("actor_generation_missing");
  const subject = input.subject ?? input.owner;
  const result = recordAuthority({
    coordRoot: input.coordRoot,
    mode: route.mode,
    signal,
    observation,
    adapter,
    native_actor_session_id: input.nativeSessionId,
    actor_instance_id: liveInstanceIdV2(input.owner),
    subject_instance_id: liveInstanceIdV2(subject),
    producer_id: LIVE_COORDINATION_V2_PRODUCER_ID,
    build_id: route.build_id,
    platform: livePlatformV2(),
    expected_prior_state_digest: authorityStateDigest(expected),
    desired_state_digest: authorityStateDigest(desired),
    reconciler: {
      readStateDigest: () => {
        const heartbeat = readHeartbeat(input.coordRoot, subject);
        if (!heartbeat || heartbeat.v2_generation_id !== expected.v2_generation_id) {
          throw new LiveCoordinationAuthorityV2Error(`heartbeat_generation_mismatch:${subject}`);
        }
        return authorityStateDigest(heartbeat);
      },
      apply: (_mutation: AuthorityMutationV2) => apply(),
    },
  });
  if (result.state === "gate_closed" || result.state === "generation_unavailable") {
    throw new LiveCoordinationAuthorityV2Error(`${result.state}:${result.reason}`);
  }
  if (result.state === "pending_transaction") {
    throw new LiveCoordinationAuthorityV2Error(`pending_transaction:${result.transaction_id}`);
  }
  return { state: "recorded", result };
}

function recordAuthority<S extends CoordinationAuthoritySignalV2>(
  input: Parameters<typeof recordCoordinationAuthorityV2<S>>[0],
): RecordCoordinationAuthorityV2Result {
  return recordCoordinationAuthorityV2(input);
}

export function liveCoordinationWriteModeV2(coordRoot: string): EventV2WriteMode {
  const route = resolveLiveEventLedgerRouteV2(coordRoot);
  if (route.state === "blocked") throw new LiveCoordinationAuthorityV2Error(route.reason);
  return route.mode;
}

function requireHeartbeat(input: LiveAuthorityBaseV2, owner: string): Heartbeat {
  const heartbeat = ensureLiveCoordinationHeartbeat(
    input.coordRoot,
    owner,
    owner === input.owner ? input.nativeSessionId : owner,
    input.adapter,
  );
  if (!heartbeat) throw new LiveCoordinationAuthorityV2Error(`heartbeat_missing:${owner}`);
  return heartbeat;
}

function authorityStateDigest(heartbeat: Heartbeat): `sha256:${string}` {
  return sha256V2(
    canonicalJsonV2({
      instance_id: heartbeat.v2_instance_id ?? heartbeat.instance_id,
      generation_id: heartbeat.v2_generation_id ?? null,
      task_state: heartbeat.v2_task_state ?? (heartbeat.task ? "set" : "cleared"),
      lifecycle_state: heartbeat.task_state ?? "active",
      task_state_reason: heartbeat.task_state_reason ?? null,
      files_touched: [...new Set(heartbeat.files_touched ?? [])].sort(),
      identity_id: heartbeat.agent_id ?? null,
      display_name: heartbeat.name ?? null,
    }),
  );
}

function canonicalClaimPath(coordRoot: string, path: string): string {
  return path.startsWith(`${coordRoot}/`) ? path.slice(coordRoot.length + 1) : path;
}
