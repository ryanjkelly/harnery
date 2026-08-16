import { createHash } from "node:crypto";
import type { ParsedPayload } from "../../hooks/adapter/parse.ts";
import type { Adapter } from "../../hooks/events/schema.ts";
import {
  type EventV2WriteMode,
  readEventV2ControlState,
  repairEventV2ControlPair,
} from "./control.ts";
import type { HookSignalV2 } from "./producers/hook.ts";
import { type RecordHookSignalV2Result, recordHookSignalV2 } from "./producers/recorder.ts";

export const LIVE_HOOK_V2_PRODUCER_ID = "prd_agent-hook" as const;
export const LIVE_COMMAND_V2_PRODUCER_ID = "prd_session-tee" as const;

export type LiveEventLedgerRouteV2 =
  | { state: "v1" }
  | { state: "v2"; mode: EventV2WriteMode; build_id: `build_${string}` }
  | { state: "blocked"; reason: string };

/**
 * Resolve the hard-cut ledger route. A missing candidate preserves V1. Once a
 * candidate manifest exists, ambiguity can never fall back to V1: a
 * manifest-first crash is repaired from its immutable packet and every other
 * invalid state closes the writer gate.
 */
export function resolveLiveEventLedgerRouteV2(coordRoot: string): LiveEventLedgerRouteV2 {
  let control = readEventV2ControlState(coordRoot);
  if (control.state === "closed") return { state: "v1" };
  if (control.state === "repairable") control = repairEventV2ControlPair(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") {
    return { state: "blocked", reason: `${control.state}:${control.reason}` };
  }
  const buildId = liveEventV2BuildId(control.genesis.profile.harnery_commit);
  if (!control.genesis.profile.producer_build_ids.includes(buildId)) {
    return { state: "blocked", reason: "live_producer_build_not_approved" };
  }
  return { state: "v2", mode: control.state, build_id: buildId };
}

export function liveEventV2BuildId(harneryCommit: string): `build_${string}` {
  const exact = harneryCommit.normalize("NFC");
  if (/^[a-zA-Z0-9._-]{1,120}$/.test(exact)) return `build_${exact}`;
  return `build_${createHash("sha256").update(exact).digest("hex")}`;
}

export function liveInstanceIdV2(instanceId: string): `inst_${string}` {
  if (/^inst_[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) return instanceId as `inst_${string}`;
  if (/^[a-zA-Z0-9._-]{1,128}$/.test(instanceId)) return `inst_${instanceId}`;
  return `inst_${createHash("sha256").update(instanceId.normalize("NFC")).digest("hex")}`;
}

export function hookSignalV2(eventName: string): HookSignalV2 | undefined {
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
    default:
      return undefined;
  }
}

export function recordLiveHookSignalV2(input: {
  coordRoot: string;
  route: Extract<LiveEventLedgerRouteV2, { state: "v2" }>;
  eventName: string;
  payload: ParsedPayload | null;
  adapter: Adapter;
  instanceId: string;
  bridge?: "codex-wsl";
  monotonic_ns?: string;
}): RecordHookSignalV2Result | { state: "ignored" } {
  const signal = hookSignalV2(input.eventName);
  if (!signal) return { state: "ignored" };
  return recordHookSignalV2({
    coordRoot: input.coordRoot,
    mode: input.route.mode,
    signal,
    payload: input.payload ?? { raw: {} },
    adapter: input.adapter,
    instance_id: liveInstanceIdV2(input.instanceId),
    producer_id: LIVE_HOOK_V2_PRODUCER_ID,
    build_id: input.route.build_id,
    platform: livePlatformV2(),
    ...(input.bridge ? { bridge: input.bridge } : {}),
    monotonic_ns: input.monotonic_ns,
  });
}

export function livePlatformV2(): "linux" | "windows" | "macos" | "unknown" {
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "unknown";
}
