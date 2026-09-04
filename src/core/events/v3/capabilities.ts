import type { EventAdapterIdV3 } from "./adapter-id.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";

export type CapabilitySupportV3 = "native" | "derived" | "conditional" | "unsupported";

export type AdapterDurationCapabilityV3 = "turn_duration" | "tool_duration";

export type CursorExecutionModeV3 = "local" | "cloud" | "unknown";

export type AdapterWaitKindV3 =
  | "permission"
  | "needs_input"
  | "decision"
  | "approval"
  | "scheduled"
  | "rate_limit"
  | "unknown";

export const ADAPTER_WAIT_KINDS_V3: readonly AdapterWaitKindV3[] = [
  "permission",
  "needs_input",
  "decision",
  "approval",
  "scheduled",
  "rate_limit",
  "unknown",
] as const;

export interface WaitKindCapabilityV3 {
  span_delivery: CapabilitySupportV3;
  turn_completeness: CapabilitySupportV3;
}

export type BaseAdapterSignalV3 =
  | "session_start"
  | "session_end"
  | "prompt"
  | "turn_id"
  | "turn_completion"
  | "assistant_reply_text"
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
  adapter: EventAdapterIdV3;
  signals: Record<AdapterSignalV3, CapabilitySupportV3>;
}

const SHARED_SIGNAL_SUPPORT = {
  session_start: "native",
  prompt: "native",
  turn_completion: "native",
  assistant_reply_text: "native",
  tool_request: "native",
  tool_result: "native",
  tool_failure: "native",
  tool_call_id: "native",
  tool_duration: "derived",
  subagent: "native",
  shell: "native",
  pre_compaction: "native",
  model_identity: "conditional",
} as const;

const BASE_SIGNAL_SUPPORT: Record<
  EventAdapterIdV3,
  Record<BaseAdapterSignalV3, CapabilitySupportV3>
> = {
  "claude-code": {
    ...SHARED_SIGNAL_SUPPORT,
    session_end: "native",
    turn_id: "conditional",
    permission: "native",
    post_compaction: "native",
    context_usage: "conditional",
  },
  codex: {
    ...SHARED_SIGNAL_SUPPORT,
    session_end: "native",
    turn_id: "native",
    permission: "native",
    post_compaction: "native",
    context_usage: "derived",
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
    context_usage: "conditional",
  },
  openclaw: {
    session_start: "conditional",
    session_end: "native",
    prompt: "native",
    turn_id: "native",
    turn_completion: "native",
    assistant_reply_text: "unsupported",
    tool_request: "native",
    tool_result: "native",
    tool_failure: "conditional",
    tool_call_id: "native",
    tool_duration: "unsupported",
    permission: "unsupported",
    subagent: "unsupported",
    shell: "native",
    pre_compaction: "unsupported",
    post_compaction: "unsupported",
    context_usage: "unsupported",
    model_identity: "unsupported",
  },
};

function profile(
  adapter: EventAdapterIdV3,
  economics: Pick<Record<AdapterSignalV3, CapabilitySupportV3>, "model_usage" | "inference_timing">,
  harnessTiming: CapabilitySupportV3 = "derived",
): AdapterCapabilityProfileV3 {
  return {
    format: "harnery-v3-adapter-capabilities",
    format_version: 1,
    adapter,
    signals: {
      ...BASE_SIGNAL_SUPPORT[adapter],
      ...economics,
      harness_timing: harnessTiming,
      capability_drift: "derived",
    },
  };
}

export const ADAPTER_CAPABILITY_PROFILES_V3: Record<EventAdapterIdV3, AdapterCapabilityProfileV3> =
  {
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
    openclaw: profile(
      "openclaw",
      {
        model_usage: "unsupported",
        inference_timing: "unsupported",
      },
      "unsupported",
    ),
  };

export function adapterCapabilityProfileV3(adapter: EventAdapterIdV3): AdapterCapabilityProfileV3 {
  return ADAPTER_CAPABILITY_PROFILES_V3[adapter];
}

export function adapterCapabilityProfileDigestV3(adapter: EventAdapterIdV3): `cap_${string}` {
  return `cap_${sha256V3(canonicalJsonV3(adapterCapabilityProfileV3(adapter))).slice(7)}`;
}

export function adapterSignalSupportV3(
  adapter: EventAdapterIdV3,
  signal: AdapterSignalV3,
): CapabilitySupportV3 {
  return adapterCapabilityProfileV3(adapter).signals[signal];
}

/**
 * Duration support for terminal spans. Tool duration is part of the digested
 * adapter profile. Turn duration predates that profile dimension, so keep its
 * compatibility-preserving classification here until the next contract major.
 */
export function adapterDurationSupportV3(
  adapter: EventAdapterIdV3,
  capability: AdapterDurationCapabilityV3,
): CapabilitySupportV3 {
  if (capability === "tool_duration") {
    return adapterSignalSupportV3(adapter, "tool_duration");
  }
  return adapter === "openclaw" ? "unsupported" : "derived";
}

/**
 * Adapter hooks only expose permission waits today. Other wait kinds can be
 * authored by coordination producers, but they are not observable from an
 * adapter's native turn channel.
 */
export function adapterWaitKindSupportV3(
  adapter: EventAdapterIdV3,
  kind: AdapterWaitKindV3,
): CapabilitySupportV3 {
  return kind === "permission" ? adapterSignalSupportV3(adapter, "permission") : "unsupported";
}

/** No current adapter supplies an independent completed-turn wait aggregate. */
export function adapterTurnWaitCountSupportV3(_adapter: EventAdapterIdV3): CapabilitySupportV3 {
  return "unsupported";
}

/**
 * Per-kind wait matrix for native adapter turns. Span delivery and independent
 * completed-turn completeness are deliberately separate: observing a span
 * never proves that an absent span means zero.
 */
export function adapterWaitCoverageMatrixV3(
  adapter: EventAdapterIdV3,
): Record<AdapterWaitKindV3, WaitKindCapabilityV3> {
  return Object.fromEntries(
    ADAPTER_WAIT_KINDS_V3.map((kind) => [
      kind,
      {
        span_delivery: adapterWaitKindSupportV3(adapter, kind),
        turn_completeness: adapterTurnWaitCountSupportV3(adapter),
      },
    ]),
  ) as Record<AdapterWaitKindV3, WaitKindCapabilityV3>;
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
