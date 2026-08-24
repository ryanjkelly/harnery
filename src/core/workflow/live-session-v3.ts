import type { Adapter } from "../adapter.ts";
import { recordLiveTaskChangeV3 } from "../agents/live-authority-v3.ts";
import { endSessionExplicitV3 } from "../agents/session-finalizer-v3.ts";
import {
  clearCoordinationCache,
  type Heartbeat,
  setIdentityCache,
} from "../agents/state/heartbeat-writer.ts";
import { readLiveCoordinationRow } from "../agents/state/live-coordination-view.ts";
import { ensureLiveCoordinationHeartbeat } from "../agents/state/live-coordination-writer.ts";
import { ensureEventLedgerV3 } from "../events/v3/bootstrap.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
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
  if (input.label) {
    recordLiveTaskChangeV3({
      coordRoot: input.coordRoot,
      owner: input.instanceId,
      nativeSessionId: sessionId,
      adapter,
      task: input.label,
    });
  }
  if (
    !setIdentityCache(
      input.coordRoot,
      input.instanceId,
      input.label ?? input.agentId,
      input.agentId,
    )
  ) {
    throw new Error("workflow_child_v3_identity_cache_failed");
  }
  const projected = readLiveCoordinationRow(input.coordRoot, input.instanceId);
  if (!projected) throw new Error("workflow_child_v3_projection_missing");
  return projected;
}

/** Record the authoritative terminal before removing the disposable coordination cache. */
export function endWorkflowChildSessionV3(
  input: WorkflowChildSessionV3Input & { cleanExit: boolean },
): void {
  requireV3Route(input.coordRoot);
  const row = readLiveCoordinationRow(input.coordRoot, input.instanceId);
  if (!row?.v3_instance_id || !row.v3_generation_id) {
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
  clearCoordinationCache(input.coordRoot, input.instanceId);
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
  if (adapter === "codex" || adapter === "cursor" || adapter === "claude-code") return adapter;
  return "claude-code";
}

export { stableScopeId } from "./scope-id.ts";
