import type { Adapter } from "../adapter.ts";
import { recordLiveTaskChangeV2 } from "../agents/live-authority-v2.ts";
import { endSessionExplicitV2 } from "../agents/session-finalizer-v2.ts";
import {
  clearCoordinationCache,
  type Heartbeat,
  setIdentityCache,
} from "../agents/state/heartbeat-writer.ts";
import {
  ensureLiveCoordinationHeartbeat,
  readLiveCoordinationRow,
} from "../agents/state/live-coordination-view.ts";
import { ensureEventLedgerV2 } from "../events/v2/bootstrap.ts";
import {
  recordLiveHookSignalV2,
  resolveLiveEventLedgerRouteV2,
} from "../events/v2/live-routing.ts";
import { stableScopeId } from "./scope-id.ts";

export interface WorkflowChildSessionV2Input {
  coordRoot: string;
  instanceId: string;
  runId: string;
  agentId: string;
  sessionId?: string;
  adapter?: string;
  label?: string;
  model?: string;
}

/** Start a headless workflow child through the same canonical V2 producer as native hooks. */
export function startWorkflowChildSessionV2(input: WorkflowChildSessionV2Input): Heartbeat {
  const adapter = workflowAdapter(input.adapter);
  const sessionId = input.sessionId ?? input.instanceId;
  const route = requireV2Route(input.coordRoot);
  const result = recordLiveHookSignalV2({
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
    throw new Error(`workflow_child_v2_start_failed:${result.state}`);
  }
  const cache = ensureLiveCoordinationHeartbeat(
    input.coordRoot,
    input.instanceId,
    sessionId,
    adapter,
    input.model,
  );
  if (!cache) throw new Error("workflow_child_v2_cache_missing");
  if (input.label) {
    recordLiveTaskChangeV2({
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
    throw new Error("workflow_child_v2_identity_cache_failed");
  }
  const projected = readLiveCoordinationRow(input.coordRoot, input.instanceId);
  if (!projected) throw new Error("workflow_child_v2_projection_missing");
  return projected;
}

/** Record the authoritative terminal before removing the disposable coordination cache. */
export function endWorkflowChildSessionV2(
  input: WorkflowChildSessionV2Input & { cleanExit: boolean },
): void {
  requireV2Route(input.coordRoot);
  const row = readLiveCoordinationRow(input.coordRoot, input.instanceId);
  if (!row?.v2_instance_id || !row.v2_generation_id) {
    throw new Error("workflow_child_v2_generation_missing");
  }
  const result = endSessionExplicitV2({
    coordRoot: input.coordRoot,
    instance_id: row.v2_instance_id,
    generation_id: row.v2_generation_id,
    coordination_finalized: true,
    outcome: input.cleanExit ? "succeeded" : "failed",
  });
  if (result.state !== "recorded" && result.state !== "already_ended") {
    throw new Error(
      `workflow_child_v2_end_failed:${result.state}${"reason" in result ? `:${result.reason}` : ""}`,
    );
  }
  clearCoordinationCache(input.coordRoot, input.instanceId);
}

function requireV2Route(coordRoot: string) {
  let route = resolveLiveEventLedgerRouteV2(coordRoot);
  if (route.state === "blocked" && route.reason === "v2_not_initialized") {
    ensureEventLedgerV2(coordRoot, "harnery-workflow-v2-universal");
    route = resolveLiveEventLedgerRouteV2(coordRoot);
  }
  if (route.state === "blocked") throw new Error(`workflow_child_v2_gate:${route.reason}`);
  return route;
}

function workflowAdapter(adapter: string | undefined): Adapter {
  if (adapter === "codex" || adapter === "cursor" || adapter === "claude-code") return adapter;
  return "claude-code";
}

export { stableScopeId } from "./scope-id.ts";
