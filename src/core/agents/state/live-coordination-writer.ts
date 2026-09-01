import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter } from "../../adapter.ts";
import {
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../../events/v3/coordination-view.ts";
import { liveInstanceIdV3, resolveLiveEventLedgerRouteV3 } from "../../events/v3/live-routing.ts";
import { type Heartbeat, readHeartbeat } from "./heartbeat-reader.ts";
import {
  isAdapterV3,
  isCurrentV3HeartbeatCache,
  observedAdapterV3,
  projectHeartbeatV3,
  type V3HeartbeatMaterialization,
} from "./live-coordination-view.ts";
import { resolveName } from "./names.ts";

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
  return materializeLiveCoordinationHeartbeat(
    coordRoot,
    nativeInstanceId,
    nativeSessionId,
    _adapter,
    model,
    false,
  );
}

/** Rebuild a disposable cache from V3 even when its generation markers look current. */
export function repairLiveCoordinationHeartbeat(
  coordRoot: string,
  nativeInstanceId: string,
  nativeSessionId: string,
  adapter: Adapter,
  model?: string,
): Heartbeat | null {
  return materializeLiveCoordinationHeartbeat(
    coordRoot,
    nativeInstanceId,
    nativeSessionId,
    adapter,
    model,
    true,
  );
}

function materializeLiveCoordinationHeartbeat(
  coordRoot: string,
  nativeInstanceId: string,
  nativeSessionId: string,
  _adapter: Adapter,
  model: string | undefined,
  force: boolean,
): Heartbeat | null {
  const route = resolveLiveEventLedgerRouteV3(coordRoot);
  if (route.state === "blocked") throw new Error(`event_v3_coordination_view:${route.reason}`);
  const view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(coordRoot));
  const generation = view.instances[liveInstanceIdV3(nativeInstanceId)];
  if (!generation?.authority_eligible) return null;
  const generationAdapter = observedAdapterV3(generation);
  if (!isAdapterV3(generationAdapter)) {
    throw new Error("event_v3_coordination_view:adapter_not_observed");
  }
  const current = readHeartbeat(coordRoot, nativeInstanceId);
  if (
    !force &&
    isCurrentV3HeartbeatCache(current, generation) &&
    current.platform === generationAdapter
  ) {
    return current;
  }

  const resolved = resolveName(coordRoot, nativeInstanceId, nativeSessionId);
  const projected = projectHeartbeatV3(coordRoot, generation, undefined, nativeInstanceId);
  // A generation reopen (resume, mid-flight onboarding) discards the stale
  // cache, but the adapter tab it names is unchanged: same native session,
  // same agent identity. Rebuilding without the naming evidence re-mints a
  // fresh suggested name on the next set-task, so a multi-day session
  // accumulates titles it is asked to display over and over. Carry the
  // naming evidence across generations; everything else re-projects from V3.
  // Same native session id means the same adapter tab; drop the carry only
  // when the durable identity observably changed (a reassumed name would make
  // the old "Agent <name> - …" block wrong for the new owner).
  const identityUnchanged = !resolved?.name || !current?.name || resolved.name === current.name;
  const carriedNaming =
    current && current.session_id === nativeSessionId && identityUnchanged
      ? {
          ...(current.suggested_session_name
            ? { suggested_session_name: current.suggested_session_name }
            : {}),
          ...(current.session_name_seen_for
            ? { session_name_seen_for: current.session_name_seen_for }
            : {}),
          ...(current.session_name_seen_at
            ? { session_name_seen_at: current.session_name_seen_at }
            : {}),
          ...(current.session_name_display_requested_for
            ? {
                session_name_display_requested_for: current.session_name_display_requested_for,
              }
            : {}),
        }
      : {};
  const materialized: V3HeartbeatMaterialization = {
    ...projected,
    ...carriedNaming,
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
