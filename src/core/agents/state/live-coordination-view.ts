import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter } from "../../adapter.ts";
import {
  type CoordinationGenerationViewV3,
  type CoordinationViewV3,
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../../events/v3/coordination-view.ts";
import { liveInstanceIdV3, resolveLiveEventLedgerRouteV3 } from "../../events/v3/live-routing.ts";
import { type Heartbeat, readHeartbeat } from "./heartbeat-writer.ts";
import { resolveName } from "./names.ts";

/**
 * Heartbeat files are disposable V3 caches. These bindings prevent a stale
 * row from a prior generation from being mistaken for current authority.
 */
export interface V3HeartbeatMaterialization extends Heartbeat {
  schema_version: 2;
  v3_instance_id: `inst_${string}`;
  v3_generation_id: `gen_${string}`;
  v3_projection_event_id: string;
  v3_task_state: "set" | "cleared";
}

/** Read the live coordination rows through the hard-cut ledger route. */
export function readLiveCoordinationRows(coordRoot: string): V3HeartbeatMaterialization[] {
  const route = resolveLiveEventLedgerRouteV3(coordRoot);
  if (route.state === "blocked") return [];
  let view: CoordinationViewV3;
  try {
    view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(coordRoot));
  } catch {
    return [];
  }
  const caches = readV3Caches(coordRoot);
  const byGeneration = new Map(
    Object.values(view.instances).map((generation) => [generation.generation_id, generation]),
  );
  return Object.values(view.instances)
    .filter((generation) => generation.authority_eligible)
    .map((generation) => {
      const parent = generation.parent_generation_id
        ? byGeneration.get(generation.parent_generation_id)
        : undefined;
      return projectHeartbeatV3(
        coordRoot,
        generation,
        matchingCache(caches, generation),
        undefined,
        parent,
      );
    });
}

/** Read one current row from the authority-safe V3 projection. */
export function readLiveCoordinationRow(
  coordRoot: string,
  nativeInstanceId: string,
): V3HeartbeatMaterialization | null {
  const route = resolveLiveEventLedgerRouteV3(coordRoot);
  if (route.state === "blocked") return null;
  try {
    const view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(coordRoot));
    const generation = view.instances[liveInstanceIdV3(nativeInstanceId)];
    if (!generation?.authority_eligible) return null;
    const cache = readHeartbeat(coordRoot, nativeInstanceId);
    const parent = generation.parent_generation_id
      ? Object.values(view.instances).find(
          (candidate) => candidate.generation_id === generation.parent_generation_id,
        )
      : undefined;
    return projectHeartbeatV3(
      coordRoot,
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
 * Resolve the adapter from the current authority-safe V3 generation. A live
 * V3 generation is stronger evidence than a missing or stale heartbeat, so
 * callers must never substitute another adapter when this function succeeds.
 */
export function liveCoordinationAdapterV3(
  coordRoot: string,
  nativeInstanceId: string,
): Adapter | null {
  const route = resolveLiveEventLedgerRouteV3(coordRoot);
  if (route.state === "blocked") throw new Error(`event_v3_coordination_view:${route.reason}`);
  const view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(coordRoot));
  const generation = view.instances[liveInstanceIdV3(nativeInstanceId)];
  if (!generation?.authority_eligible) return null;
  const adapter = observedAdapter(generation);
  if (!isAdapter(adapter)) {
    throw new Error("event_v3_coordination_view:adapter_not_observed");
  }
  return adapter;
}

/**
 * Ensure the current V3 generation has a mutation target. The resulting file
 * is explicitly generation-bound and disposable: V3 remains the source of
 * truth, while the cache gives the crash-safe authority outbox an atomic local
 * state to reconcile.
 */
export function ensureLiveCoordinationHeartbeat(
  coordRoot: string,
  nativeInstanceId: string,
  nativeSessionId: string,
  _adapter: Adapter,
  model?: string,
): Heartbeat | null {
  const route = resolveLiveEventLedgerRouteV3(coordRoot);
  if (route.state === "blocked") throw new Error(`event_v3_coordination_view:${route.reason}`);
  const view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(coordRoot));
  const generation = view.instances[liveInstanceIdV3(nativeInstanceId)];
  if (!generation?.authority_eligible) return null;
  const generationAdapter = observedAdapter(generation);
  if (!isAdapter(generationAdapter)) {
    throw new Error("event_v3_coordination_view:adapter_not_observed");
  }
  const current = readHeartbeat(coordRoot, nativeInstanceId);
  if (isCurrentCache(current, generation) && current.platform === generationAdapter) return current;

  const resolved = resolveName(coordRoot, nativeInstanceId, nativeSessionId);
  const projected = projectHeartbeatV3(coordRoot, generation, undefined, nativeInstanceId);
  const materialized: V3HeartbeatMaterialization = {
    ...projected,
    schema_version: 2,
    instance_id: nativeInstanceId,
    session_id: nativeSessionId,
    name: resolved?.name ?? "",
    kind: resolved?.kind ?? projected.kind,
    agent_id: resolved?.agent_id ?? (resolved?.kind === "subagent" ? nativeInstanceId : ""),
    model: projected.model ?? model ?? "",
    platform: generationAdapter,
    v3_instance_id: generation.instance_id as `inst_${string}`,
    v3_generation_id: generation.generation_id as `gen_${string}`,
    v3_projection_event_id: generation.last_event_id,
    v3_task_state: generation.task_state === "set" ? "set" : "cleared",
  };
  writeHeartbeatCache(coordRoot, nativeInstanceId, materialized);
  return materialized;
}

function readCacheRows(coordRoot: string): Heartbeat[] {
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

function readV3Caches(coordRoot: string): Heartbeat[] {
  return readCacheRows(coordRoot).filter(
    (row) => row.schema_version === 2 && typeof row.v3_generation_id === "string",
  );
}

function matchingCache(
  caches: Heartbeat[],
  generation: CoordinationGenerationViewV3,
): Heartbeat | undefined {
  return caches.find((cache) => isCurrentCache(cache, generation));
}

function isCurrentCache(
  cache: Heartbeat | null | undefined,
  generation: CoordinationGenerationViewV3,
): cache is Heartbeat {
  return (
    cache?.schema_version === 2 &&
    cache.v3_instance_id === generation.instance_id &&
    cache.v3_generation_id === generation.generation_id
  );
}

function projectHeartbeatV3(
  coordRoot: string,
  generation: CoordinationGenerationViewV3,
  cache: Heartbeat | undefined,
  nativeInstanceId: string | undefined,
  parent?: CoordinationGenerationViewV3,
): V3HeartbeatMaterialization {
  const adapter = observedAdapter(generation) ?? cache?.platform ?? "unknown";
  const model = observedModel(generation) ?? cache?.model ?? "";
  const instanceId =
    nativeInstanceId ?? cache?.instance_id ?? displayInstanceId(generation.instance_id);
  const durableIdentity = resolveName(
    coordRoot,
    instanceId,
    cache?.session_id ?? generation.session_id,
  );
  const taskIsSet = generation.task_state === "set";
  const lifecycle = isLifecycleState(generation.lifecycle_state)
    ? generation.lifecycle_state
    : "active";
  return {
    schema_version: 2,
    instance_id: instanceId,
    session_id: parent?.session_id ?? generation.session_id,
    native_session_id: cache?.session_id,
    name: cache?.name || durableIdentity?.name,
    kind:
      cache?.kind ??
      durableIdentity?.kind ??
      (generation.parent_generation_id || generation.delegation_id
        ? "subagent"
        : generation.workflow_id
          ? "workflow-child"
          : "session"),
    agent_id: cache?.agent_id ?? durableIdentity?.agent_id,
    model,
    platform: adapter,
    started_at: generation.started_at,
    last_heartbeat: generation.last_observed_at,
    files_touched: generation.files_touched,
    ...(taskIsSet && cache?.task ? { task: cache.task } : {}),
    task_updated_at: taskIsSet ? cache?.task_updated_at : null,
    activity: generation.activity === "terminal" ? "idle" : generation.activity,
    activity_updated_at: generation.last_observed_at,
    activity_source: "event-v3-coordination-view",
    task_state: lifecycle,
    task_state_updated_at: generation.last_observed_at,
    task_state_reason: lifecycle === "blocked" ? cache?.task_state_reason : undefined,
    suggested_session_name: cache?.suggested_session_name,
    session_name_seen_at: cache?.session_name_seen_at,
    session_name_seen_for: cache?.session_name_seen_for,
    workflow_run_id: generation.run_id,
    workflow_agent_id: generation.workflow_agent_id,
    parent_instance_id: parent ? displayInstanceId(parent.instance_id) : undefined,
    v3_instance_id: generation.instance_id as `inst_${string}`,
    v3_generation_id: generation.generation_id as `gen_${string}`,
    v3_projection_event_id: generation.last_event_id,
    v3_task_state: taskIsSet ? "set" : "cleared",
  };
}

function observedAdapter(generation: CoordinationGenerationViewV3): string | undefined {
  const observation = generation.runtime_attestation.adapter;
  return observation.state === "observed" ? observation.value.id : undefined;
}

function isAdapter(value: string | undefined): value is Adapter {
  return value === "claude-code" || value === "cursor" || value === "codex";
}

function observedModel(generation: CoordinationGenerationViewV3): string | undefined {
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
