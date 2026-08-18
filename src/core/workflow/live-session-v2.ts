import { createHash } from "node:crypto";
import type { Adapter } from "../adapter.ts";
import { recordLiveTaskChangeV2 } from "../agents/live-authority-v2.ts";
import {
  type Heartbeat,
  killHeartbeat,
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
  const adapter = workflowAdapter(input.adapter);
  const route = requireV2Route(input.coordRoot);
  const result = recordLiveHookSignalV2({
    coordRoot: input.coordRoot,
    route,
    eventName: "session-end",
    adapter,
    instanceId: input.instanceId,
    run_id: stableScopeId("run", input.runId),
    workflow_id: stableScopeId("wf", input.runId),
    payload: {
      session_id: input.sessionId ?? input.instanceId,
      clean_exit: input.cleanExit,
      raw: {},
    },
  });
  if (result.state !== "recorded") {
    throw new Error(`workflow_child_v2_end_failed:${result.state}`);
  }
  killHeartbeat(input.coordRoot, input.instanceId);
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

function stableScopeId<P extends "run" | "wf">(prefix: P, value: string): `${P}_${string}` {
  return `${prefix}_${createHash("sha256").update(value.normalize("NFC")).digest("hex")}`;
}
