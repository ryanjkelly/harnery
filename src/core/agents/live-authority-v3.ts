import { randomUUID } from "node:crypto";
import type { Adapter } from "../adapter.ts";
import type { AuthorityMutationV3 } from "../events/v3/authority-outbox.ts";
import { canonicalJsonV3, sha256V3 } from "../events/v3/canonical.ts";
import type { EventV3WriteMode } from "../events/v3/control.ts";
import {
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

interface LiveAuthorityBaseV3 {
  coordRoot: string;
  owner: string;
  subject?: string;
  nativeSessionId: string;
  adapter: Adapter;
  observationId?: string;
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

function canonicalClaimPath(coordRoot: string, path: string): string {
  return path.startsWith(`${coordRoot}/`) ? path.slice(coordRoot.length + 1) : path;
}
