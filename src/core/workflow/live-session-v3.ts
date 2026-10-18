import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname } from "node:path";
import { type Adapter, adapterFromPlatform } from "../adapter.ts";
import {
  recordLiveLifecycleChangeV3,
  recordLiveTaskChangeV3,
} from "../agents/live-authority-v3.ts";
import { endSessionExplicitV3 } from "../agents/session-finalizer-v3.ts";
import { heartbeatPath } from "../agents/state/heartbeat-reader.ts";
import {
  type Heartbeat,
  readHeartbeat,
  setIdentityCache,
} from "../agents/state/heartbeat-writer.ts";
import { readLiveCoordinationRow } from "../agents/state/live-coordination-view.ts";
import { ensureLiveCoordinationHeartbeat } from "../agents/state/live-coordination-writer.ts";
import { assignName } from "../agents/state/names.ts";
import { coordFreshnessSeconds } from "../config.ts";
import { ensureEventLedgerV3 } from "../events/v3/bootstrap.ts";
import {
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../events/v3/coordination-view.ts";
import { withGenerationCustodyV3 } from "../events/v3/generation-custody.ts";
import {
  liveInstanceIdV3,
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { readHookProducerStateV3 } from "../events/v3/producers/recorder.ts";
import { fsyncParentDirectory } from "./durable-record.ts";
import { stableScopeId } from "./scope-id.ts";

export interface WorkflowChildSessionV3Input {
  coordRoot: string;
  instanceId: string;
  runId: string;
  agentId: string;
  sessionId?: string;
  adapter?: string;
  label?: string;
  model?: string;
}

/** Start a headless workflow child through the same canonical V3 producer as native hooks. */
export function startWorkflowChildSessionV3(input: WorkflowChildSessionV3Input): Heartbeat {
  const adapter = workflowAdapter(input.adapter);
  const sessionId = input.sessionId ?? input.instanceId;
  const route = requireV3Route(input.coordRoot);
  const result = recordLiveHookSignalV3({
    coordRoot: input.coordRoot,
    route,
    eventName: "session-start",
    adapter,
    instanceId: input.instanceId,
    run_id: stableScopeId("run", input.runId),
    workflow_id: stableScopeId("wf", input.runId),
    workflow_agent_id: input.agentId,
    payload: {
      session_id: sessionId,
      model: input.model,
      source: "workflow-engine",
      raw: {},
    },
  });
  if (result.state !== "recorded" && result.state !== "already_started") {
    throw new Error(`workflow_child_v3_start_failed:${result.state}`);
  }
  const cache = ensureLiveCoordinationHeartbeat(
    input.coordRoot,
    input.instanceId,
    sessionId,
    adapter,
    input.model,
  );
  if (!cache) throw new Error("workflow_child_v3_cache_missing");
  const name = assignName(input.coordRoot, input.instanceId, "workflow-child", {
    freshnessSecs: coordFreshnessSeconds(input.coordRoot),
  });
  if (input.label) {
    recordLiveTaskChangeV3({
      coordRoot: input.coordRoot,
      owner: input.instanceId,
      nativeSessionId: sessionId,
      adapter,
      task: input.label,
    });
  }
  if (!setIdentityCache(input.coordRoot, input.instanceId, name, input.agentId)) {
    throw new Error("workflow_child_v3_identity_cache_failed");
  }
  const projected = readLiveCoordinationRow(input.coordRoot, input.instanceId);
  if (!projected) throw new Error("workflow_child_v3_projection_missing");
  const own = readHookProducerStateV3(input.coordRoot, adapter, sessionId);
  if (!own || own.terminal || own.generation_id !== projected.v3_generation_id) {
    throw new Error("workflow_child_v3_start_generation_changed");
  }
  return projected;
}

/** Record the authoritative terminal before removing the disposable coordination cache. */
export function endWorkflowChildSessionV3(
  input: WorkflowChildSessionV3Input & { cleanExit: boolean; expectedGenerationId: string },
): void {
  withGenerationCustodyV3(input.coordRoot, [liveInstanceIdV3(input.instanceId)], () =>
    endExpectedChild(input),
  );
}

function endExpectedChild(
  input: WorkflowChildSessionV3Input & { cleanExit: boolean; expectedGenerationId: string },
): void {
  requireV3Route(input.coordRoot);
  const view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(input.coordRoot));
  const instanceId = liveInstanceIdV3(input.instanceId);
  const current = view.instances[instanceId];
  const terminal = view.terminal_generations[input.expectedGenerationId];
  if (terminal?.instance_id === instanceId) recoverHeldCaches(input);
  if (current && current.generation_id !== input.expectedGenerationId) {
    throw new Error("workflow_child_v3_generation_changed");
  }
  if (!current) {
    if (!terminal || terminal.instance_id !== instanceId)
      throw new Error("workflow_child_v3_generation_missing");
    if (terminal.terminal?.outcome !== (input.cleanExit ? "succeeded" : "failed")) {
      throw new Error("workflow_child_v3_terminal_outcome_changed");
    }
    clearExpectedCache(input);
    return;
  }
  const row = readLiveCoordinationRow(input.coordRoot, input.instanceId);
  if (!row?.v3_instance_id || row.v3_generation_id !== input.expectedGenerationId) {
    throw new Error("workflow_child_v3_generation_missing");
  }
  const result = endSessionExplicitV3({
    coordRoot: input.coordRoot,
    instance_id: row.v3_instance_id,
    generation_id: row.v3_generation_id,
    coordination_finalized: true,
    outcome: input.cleanExit ? "succeeded" : "failed",
  });
  if (result.state !== "recorded" && result.state !== "already_ended") {
    throw new Error(
      `workflow_child_v3_end_failed:${result.state}${"reason" in result ? `:${result.reason}` : ""}`,
    );
  }
  clearExpectedCache(input);
}

/** Persist unresolved terminal custody only for the generation this dispatch owns. */
export function recordWorkflowChildTerminalFailureV3(
  input: WorkflowChildSessionV3Input & { expectedGenerationId: string; reason: string },
): void {
  withGenerationCustodyV3(input.coordRoot, [liveInstanceIdV3(input.instanceId)], () => {
    const row = readLiveCoordinationRow(input.coordRoot, input.instanceId);
    if (!row || row.v3_generation_id !== input.expectedGenerationId) return;
    recordLiveLifecycleChangeV3({
      coordRoot: input.coordRoot,
      owner: input.instanceId,
      nativeSessionId: input.sessionId ?? input.instanceId,
      adapter: workflowAdapter(input.adapter),
      expectedGenerationId: input.expectedGenerationId as `gen_${string}`,
      state: "blocked",
      reason: input.reason,
    });
  });
}

function heldPrefix(input: WorkflowChildSessionV3Input & { expectedGenerationId: string }): string {
  if (!/^gen_[a-zA-Z0-9._-]{1,128}$/.test(input.expectedGenerationId))
    throw new Error("workflow_child_v3_generation_invalid");
  return `${basename(heartbeatPath(input.coordRoot, input.instanceId))}.terminal-${input.expectedGenerationId}-`;
}

function recoverHeldCaches(
  input: WorkflowChildSessionV3Input & { expectedGenerationId: string },
): void {
  const path = heartbeatPath(input.coordRoot, input.instanceId);
  if (!existsSync(dirname(path))) return;
  const prefix = heldPrefix(input);
  for (const name of readdirSync(dirname(path)).filter((value) => value.startsWith(prefix))) {
    finishHeldCache(`${dirname(path)}/${name}`, path, input.expectedGenerationId);
  }
}

function clearExpectedCache(
  input: WorkflowChildSessionV3Input & { expectedGenerationId: string },
): void {
  recoverHeldCaches(input);
  if (
    readHeartbeat(input.coordRoot, input.instanceId)?.v3_generation_id !==
    input.expectedGenerationId
  )
    return;
  const path = heartbeatPath(input.coordRoot, input.instanceId);
  const held = `${dirname(path)}/${heldPrefix(input)}${randomUUID()}`;
  try {
    // A unique held name pins the actual bytes atomically. Checking before
    // unlink alone could consume a replacement published at this boundary.
    renameSync(path, held);
    fsyncParentDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  finishHeldCache(held, path, input.expectedGenerationId);
}

function finishHeldCache(held: string, path: string, expectedGenerationId: string): void {
  let removed = false;
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    const cache = JSON.parse(readFileSync(held, "utf8")) as Heartbeat;
    if (cache.v3_generation_id === expectedGenerationId) {
      unlinkSync(held);
      fsyncParentDirectory(held);
      removed = true;
    }
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }
  if (!removed) {
    try {
      // Never overwrite a later publication. Keep the held evidence when
      // another cache already owns the live name.
      linkSync(held, path);
      fsyncParentDirectory(path);
      unlinkSync(held);
      fsyncParentDirectory(held);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (cleanupFailed) {
          throw new AggregateError(
            [cleanupError, error],
            `workflow_child_v3_cache_cleanup_and_restore_failed: ${String(cleanupError)}; restoration: ${String(error)}`,
          );
        }
        throw error;
      }
    }
  }
  if (cleanupFailed) throw cleanupError;
}

function requireV3Route(coordRoot: string) {
  let route = resolveLiveEventLedgerRouteV3(coordRoot);
  if (route.state === "blocked" && route.reason === "v3_not_initialized") {
    ensureEventLedgerV3(coordRoot, "harnery-workflow-v3-universal");
    route = resolveLiveEventLedgerRouteV3(coordRoot);
  }
  if (route.state === "blocked") throw new Error(`workflow_child_v3_gate:${route.reason}`);
  return route;
}

function workflowAdapter(adapter: string | undefined): Adapter {
  return adapterFromPlatform(adapter, { context: "workflow-child" });
}

export { stableScopeId } from "./scope-id.ts";
