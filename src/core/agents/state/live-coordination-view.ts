import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type CoordinationGenerationViewV2,
  type CoordinationViewV2,
  readCoordinationViewV2,
  requireAuthoritySafeCoordinationViewV2,
} from "../../events/v2/coordination-view.ts";
import { liveInstanceIdV2, resolveLiveEventLedgerRouteV2 } from "../../events/v2/live-routing.ts";
import type { Adapter } from "../../hooks/events/schema.ts";
import { type Heartbeat, healHeartbeat, readHeartbeat } from "./heartbeat-writer.ts";
import { resolveName } from "./names.ts";

/**
 * The legacy heartbeat file is only a disposable local cache after the V2
 * cutover. These bindings prevent an old V1 row (or a row from a prior V2
 * generation) from being mistaken for current coordination authority.
 */
export interface V2HeartbeatMaterialization extends Heartbeat {
  schema_version: 2;
  v2_instance_id: `inst_${string}`;
  v2_generation_id: `gen_${string}`;
  v2_projection_event_id: string;
  v2_task_state: "set" | "cleared";
}

/** Read the live coordination rows through the hard-cut ledger route. */
export function readLiveCoordinationRows(coordRoot: string): Heartbeat[] {
  const route = resolveLiveEventLedgerRouteV2(coordRoot);
  if (route.state === "v1") return readV1Rows(coordRoot);
  if (route.state === "blocked") return [];
  let view: CoordinationViewV2;
  try {
    view = requireAuthoritySafeCoordinationViewV2(readCoordinationViewV2(coordRoot));
  } catch {
    return [];
  }
  const caches = readV2Caches(coordRoot);
  const byGeneration = new Map(
    Object.values(view.instances).map((generation) => [generation.generation_id, generation]),
  );
  return Object.values(view.instances)
    .filter((generation) => generation.authority_eligible)
    .map((generation) => {
      const parent = generation.parent_generation_id
        ? byGeneration.get(generation.parent_generation_id)
        : undefined;
      return projectHeartbeatV2(generation, matchingCache(caches, generation), undefined, parent);
    });
}

/** Read one current row without ever falling back to stale V1 state in V2. */
export function readLiveCoordinationRow(
  coordRoot: string,
  nativeInstanceId: string,
): Heartbeat | null {
  const route = resolveLiveEventLedgerRouteV2(coordRoot);
  if (route.state === "v1") return readHeartbeat(coordRoot, nativeInstanceId);
  if (route.state === "blocked") return null;
  try {
    const view = requireAuthoritySafeCoordinationViewV2(readCoordinationViewV2(coordRoot));
    const generation = view.instances[liveInstanceIdV2(nativeInstanceId)];
    if (!generation?.authority_eligible) return null;
    const cache = readHeartbeat(coordRoot, nativeInstanceId);
    const parent = generation.parent_generation_id
      ? Object.values(view.instances).find(
          (candidate) => candidate.generation_id === generation.parent_generation_id,
        )
      : undefined;
    return projectHeartbeatV2(
      generation,
      isCurrentCache(cache, generation) ? cache : undefined,
      nativeInstanceId,
      parent,
    );
  } catch {
    return null;
  }
}

/**
 * Ensure the current V2 generation has a mutation target. The resulting file
 * is explicitly generation-bound and disposable: V2 remains the source of
 * truth, while the cache gives the crash-safe authority outbox an atomic local
 * state to reconcile.
 */
export function ensureLiveCoordinationHeartbeat(
  coordRoot: string,
  nativeInstanceId: string,
  nativeSessionId: string,
  adapter: Adapter,
  model?: string,
): Heartbeat | null {
  const route = resolveLiveEventLedgerRouteV2(coordRoot);
  if (route.state === "v1") {
    return healHeartbeat(coordRoot, nativeInstanceId, nativeSessionId, model, adapter);
  }
  if (route.state === "blocked") throw new Error(`event_v2_coordination_view:${route.reason}`);
  const view = requireAuthoritySafeCoordinationViewV2(readCoordinationViewV2(coordRoot));
  const generation = view.instances[liveInstanceIdV2(nativeInstanceId)];
  if (!generation?.authority_eligible) return null;
  const current = readHeartbeat(coordRoot, nativeInstanceId);
  if (isCurrentCache(current, generation)) return current;

  const resolved = resolveName(coordRoot, nativeInstanceId, nativeSessionId);
  const projected = projectHeartbeatV2(generation, undefined, nativeInstanceId);
  const materialized: V2HeartbeatMaterialization = {
    ...projected,
    schema_version: 2,
    instance_id: nativeInstanceId,
    session_id: nativeSessionId,
    name: resolved?.name ?? "",
    kind: resolved?.kind ?? projected.kind,
    agent_id: resolved?.agent_id ?? (resolved?.kind === "subagent" ? nativeInstanceId : ""),
    model: model ?? projected.model ?? "",
    platform: adapter,
    v2_instance_id: generation.instance_id as `inst_${string}`,
    v2_generation_id: generation.generation_id as `gen_${string}`,
    v2_projection_event_id: generation.last_event_id,
    v2_task_state: generation.task_state === "set" ? "set" : "cleared",
  };
  writeHeartbeatCache(coordRoot, nativeInstanceId, materialized);
  return materialized;
}

function readV1Rows(coordRoot: string): Heartbeat[] {
  const dir = join(coordRoot, ".harnery", "active");
  if (!existsSync(dir)) return [];
  const rows: Heartbeat[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      rows.push(JSON.parse(readFileSync(join(dir, file), "utf8")) as Heartbeat);
    } catch {
      // A partial heartbeat is ignored exactly as before.
    }
  }
  return rows;
}

function readV2Caches(coordRoot: string): Heartbeat[] {
  return readV1Rows(coordRoot).filter(
    (row) => row.schema_version === 2 && typeof row.v2_generation_id === "string",
  );
}

function matchingCache(
  caches: Heartbeat[],
  generation: CoordinationGenerationViewV2,
): Heartbeat | undefined {
  return caches.find((cache) => isCurrentCache(cache, generation));
}

function isCurrentCache(
  cache: Heartbeat | null | undefined,
  generation: CoordinationGenerationViewV2,
): cache is Heartbeat {
  return (
    cache?.schema_version === 2 &&
    cache.v2_instance_id === generation.instance_id &&
    cache.v2_generation_id === generation.generation_id
  );
}

function projectHeartbeatV2(
  generation: CoordinationGenerationViewV2,
  cache: Heartbeat | undefined,
  nativeInstanceId: string | undefined,
  parent?: CoordinationGenerationViewV2,
): Heartbeat {
  const adapter = observedAdapter(generation) ?? cache?.platform ?? "unknown";
  const model = observedModel(generation) ?? cache?.model ?? "";
  const taskIsSet = generation.task_state === "set";
  const lifecycle = isLifecycleState(generation.lifecycle_state)
    ? generation.lifecycle_state
    : "active";
  return {
    schema_version: 2,
    instance_id:
      nativeInstanceId ?? cache?.instance_id ?? displayInstanceId(generation.instance_id),
    session_id: parent?.session_id ?? generation.session_id,
    name: cache?.name,
    kind:
      cache?.kind ??
      (generation.parent_generation_id || generation.delegation_id
        ? "subagent"
        : generation.workflow_id
          ? "workflow-child"
          : "session"),
    agent_id: cache?.agent_id,
    model,
    platform: adapter,
    started_at: generation.started_at,
    last_heartbeat: generation.last_observed_at,
    files_touched: generation.files_touched,
    ...(taskIsSet && cache?.task ? { task: cache.task } : {}),
    task_updated_at: taskIsSet ? cache?.task_updated_at : null,
    activity: generation.activity === "terminal" ? "idle" : generation.activity,
    task_state: lifecycle,
    task_state_reason: lifecycle === "blocked" ? cache?.task_state_reason : undefined,
    suggested_session_name: cache?.suggested_session_name,
    session_name_seen_at: cache?.session_name_seen_at,
    session_name_seen_for: cache?.session_name_seen_for,
    workflow_run_id: generation.run_id,
    parent_instance_id: parent ? displayInstanceId(parent.instance_id) : undefined,
    v2_instance_id: generation.instance_id as `inst_${string}`,
    v2_generation_id: generation.generation_id as `gen_${string}`,
    v2_projection_event_id: generation.last_event_id,
    v2_task_state: taskIsSet ? "set" : "cleared",
  };
}

function observedAdapter(generation: CoordinationGenerationViewV2): string | undefined {
  const observation = generation.runtime_attestation.adapter;
  return observation.state === "observed" ? observation.value.id : undefined;
}

function observedModel(generation: CoordinationGenerationViewV2): string | undefined {
  const observation = generation.runtime_attestation.model;
  return observation.state === "observed" ? observation.value.id : undefined;
}

function isLifecycleState(value: string | undefined): value is "active" | "blocked" | "done" {
  return value === "active" || value === "blocked" || value === "done";
}

function displayInstanceId(instanceId: string): string {
  return instanceId.startsWith("inst_") ? instanceId.slice("inst_".length) : instanceId;
}

function writeHeartbeatCache(coordRoot: string, instanceId: string, heartbeat: Heartbeat): void {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) {
    throw new Error("instance_id is unsafe for heartbeat materialization");
  }
  const path = join(coordRoot, ".harnery", "active", `${instanceId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(heartbeat, null, 2), "utf8");
  renameSync(temporary, path);
}
