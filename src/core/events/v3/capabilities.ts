import type { Adapter } from "../../adapter.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";

export type CapabilitySupportV3 = "native" | "derived" | "conditional" | "unsupported";

export type CursorExecutionModeV3 = "local" | "cloud" | "unknown";

export type AdapterWaitKindV3 =
  | "permission"
  | "needs_input"
  | "decision"
  | "approval"
  | "scheduled"
  | "rate_limit"
  | "unknown";

export type BaseAdapterSignalV3 =
  | "session_start"
  | "session_end"
  | "prompt"
  | "turn_id"
  | "turn_completion"
  | "tool_request"
  | "tool_result"
  | "tool_failure"
  | "tool_call_id"
  | "tool_duration"
  | "permission"
  | "subagent"
  | "shell"
  | "pre_compaction"
  | "post_compaction"
  | "context_usage"
  | "model_identity";

export type AdapterSignalV3 =
  | BaseAdapterSignalV3
  | "model_usage"
  | "inference_timing"
  | "harness_timing"
  | "capability_drift";

export interface AdapterCapabilityProfileV3 {
  format: "harnery-v3-adapter-capabilities";
  format_version: 1;
  adapter: Adapter;
  signals: Record<AdapterSignalV3, CapabilitySupportV3>;
}

const SHARED_SIGNAL_SUPPORT = {
  session_start: "native",
  prompt: "native",
  turn_completion: "native",
  tool_request: "native",
  tool_result: "native",
  tool_failure: "native",
  tool_call_id: "native",
  tool_duration: "derived",
  subagent: "native",
  shell: "native",
  pre_compaction: "native",
  context_usage: "native",
  model_identity: "conditional",
} as const;

const BASE_SIGNAL_SUPPORT: Record<Adapter, Record<BaseAdapterSignalV3, CapabilitySupportV3>> = {
  "claude-code": {
    ...SHARED_SIGNAL_SUPPORT,
    session_end: "native",
    turn_id: "conditional",
    permission: "native",
    post_compaction: "native",
  },
  codex: {
    ...SHARED_SIGNAL_SUPPORT,
    session_end: "native",
    turn_id: "native",
    permission: "native",
    post_compaction: "native",
  },
  cursor: {
    ...SHARED_SIGNAL_SUPPORT,
    session_end: "native",
    turn_id: "unsupported",
    tool_request: "conditional",
    tool_result: "conditional",
    tool_failure: "conditional",
    tool_call_id: "conditional",
    tool_duration: "conditional",
    shell: "conditional",
    permission: "conditional",
    post_compaction: "unsupported",
  },
};

function profile(
  adapter: Adapter,
  economics: Pick<Record<AdapterSignalV3, CapabilitySupportV3>, "model_usage" | "inference_timing">,
): AdapterCapabilityProfileV3 {
  return {
    format: "harnery-v3-adapter-capabilities",
    format_version: 1,
    adapter,
    signals: {
      ...BASE_SIGNAL_SUPPORT[adapter],
      ...economics,
      harness_timing: "derived",
      capability_drift: "derived",
    },
  };
}

export const ADAPTER_CAPABILITY_PROFILES_V3: Record<Adapter, AdapterCapabilityProfileV3> = {
  "claude-code": profile("claude-code", {
    model_usage: "conditional",
    inference_timing: "unsupported",
  }),
  codex: profile("codex", {
    model_usage: "conditional",
    inference_timing: "unsupported",
  }),
  cursor: profile("cursor", {
    model_usage: "unsupported",
    inference_timing: "unsupported",
  }),
};

export function adapterCapabilityProfileV3(adapter: Adapter): AdapterCapabilityProfileV3 {
  return ADAPTER_CAPABILITY_PROFILES_V3[adapter];
}

export function adapterCapabilityProfileDigestV3(adapter: Adapter): `cap_${string}` {
  return `cap_${sha256V3(canonicalJsonV3(adapterCapabilityProfileV3(adapter))).slice(7)}`;
}

export function adapterSignalSupportV3(
  adapter: Adapter,
  signal: AdapterSignalV3,
): CapabilitySupportV3 {
  return adapterCapabilityProfileV3(adapter).signals[signal];
}

/**
 * Adapter hooks only expose permission waits today. Other wait kinds can be
 * authored by coordination producers, but they are not observable from an
 * adapter's native turn channel.
 */
export function adapterWaitKindSupportV3(
  adapter: Adapter,
  kind: AdapterWaitKindV3,
): CapabilitySupportV3 {
  return kind === "permission" ? adapterSignalSupportV3(adapter, "permission") : "unsupported";
}

/** No current adapter supplies an independent completed-turn wait aggregate. */
export function adapterTurnWaitCountSupportV3(_adapter: Adapter): CapabilitySupportV3 {
  return "unsupported";
}

/**
 * Local Cursor sessions expose the generic tool channel. Cloud/private-worker
 * sessions cannot guarantee whole-turn delivery because hooks may start only
 * after the execution environment becomes writable.
 */
export function cursorToolChannelSupportV3(mode: CursorExecutionModeV3): CapabilitySupportV3 {
  if (mode === "local") return "native";
  if (mode === "cloud") return "unsupported";
  return "conditional";
}
