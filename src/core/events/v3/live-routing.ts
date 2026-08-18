import { createHash } from "node:crypto";
import type { Adapter } from "../../adapter.ts";
import type { ParsedPayload } from "../../hooks/adapter/parse.ts";
import {
  type EventV3WriteMode,
  readEventV3ControlState,
  repairEventV3ControlPair,
} from "./control.ts";
import type { HookSignalV3 } from "./producers/hook.ts";
import { type RecordHookSignalV3Result, recordHookSignalV3 } from "./producers/recorder.ts";

export const LIVE_HOOK_V3_PRODUCER_ID = "prd_agent-hook" as const;
export const LIVE_COMMAND_V3_PRODUCER_ID = "prd_session-tee" as const;

export type LiveEventLedgerRouteV3 =
  | { state: "v3"; mode: EventV3WriteMode; build_id: `build_${string}` }
  | { state: "blocked"; reason: string };

/**
 * Resolve the V3-only ledger route. A root without an initialized V3 control
 * packet is blocked; no producer or consumer may fall back to an older ledger.
 * Manifest-first crashes are repaired from the immutable packet and every
 * other invalid state closes the writer gate.
 */
export function resolveLiveEventLedgerRouteV3(coordRoot: string): LiveEventLedgerRouteV3 {
  let control = readEventV3ControlState(coordRoot);
  if (control.state === "closed") return { state: "blocked", reason: "v3_not_initialized" };
  if (control.state === "repairable") control = repairEventV3ControlPair(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") {
    return { state: "blocked", reason: `${control.state}:${control.reason}` };
  }
  const buildId = liveEventV3BuildId(control.genesis.profile.harnery_commit);
  if (!control.genesis.profile.producer_build_ids.includes(buildId)) {
    return { state: "blocked", reason: "live_producer_build_not_approved" };
  }
  return { state: "v3", mode: control.state, build_id: buildId };
}

export function liveEventV3BuildId(harneryCommit: string): `build_${string}` {
  const exact = harneryCommit.normalize("NFC");
  if (/^[a-zA-Z0-9._-]{1,120}$/.test(exact)) return `build_${exact}`;
  return `build_${createHash("sha256").update(exact).digest("hex")}`;
}

export function liveInstanceIdV3(instanceId: string): `inst_${string}` {
  if (/^inst_[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) return instanceId as `inst_${string}`;
  if (/^[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) return `inst_${instanceId}`;
  return `inst_${createHash("sha256").update(instanceId.normalize("NFC")).digest("hex")}`;
}

export function hookSignalV3(eventName: string): HookSignalV3 | undefined {
  switch (eventName) {
    case "session-start":
    case "session-end":
    case "user-prompt-submit":
    case "stop":
    case "stop-failure":
    case "pre-tool-use":
    case "post-tool-use":
    case "post-tool-use-failure":
    case "permission-request":
    case "sub-agent-start":
    case "sub-agent-stop":
    case "pre-compact":
    case "post-compact":
      return eventName;
    case "before-shell-execution":
      return "pre-tool-use";
    case "after-shell-execution":
      return "post-tool-use";
    default:
      return undefined;
  }
}

export function recordLiveHookSignalV3(input: {
  coordRoot: string;
  route: Extract<LiveEventLedgerRouteV3, { state: "v3" }>;
  eventName: string;
  payload: ParsedPayload | null;
  adapter: Adapter;
  instanceId: string;
  run_id?: `run_${string}`;
  workflow_id?: `wf_${string}`;
  workflow_agent_id?: string;
  bridge?: "codex-wsl";
  monotonic_ns?: string;
  hook_name?: string;
  hook_duration_ms?: number;
}): RecordHookSignalV3Result | { state: "ignored" } {
  const signal = hookSignalV3(input.eventName);
  if (!signal) return { state: "ignored" };
  return recordHookSignalV3({
    coordRoot: input.coordRoot,
    mode: input.route.mode,
    signal,
    payload: input.payload ?? { raw: {} },
    adapter: input.adapter,
    instance_id: liveInstanceIdV3(input.instanceId),
    run_id: input.run_id,
    workflow_id: input.workflow_id,
    workflow_agent_id: input.workflow_agent_id,
    producer_id: LIVE_HOOK_V3_PRODUCER_ID,
    build_id: input.route.build_id,
    platform: livePlatformV3(),
    ...(input.bridge ? { bridge: input.bridge } : {}),
    monotonic_ns: input.monotonic_ns,
    hook_name: input.hook_name,
    hook_duration_ms: input.hook_duration_ms,
  });
}

export function livePlatformV3(): "linux" | "windows" | "macos" | "unknown" {
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "unknown";
}
