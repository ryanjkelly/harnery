import type { Adapter } from "../../hooks/events/schema.ts";
import { canonicalJsonV2, sha256V2 } from "./canonical.ts";

export type CapabilitySupportV2 = "native" | "derived" | "conditional" | "unsupported";

export type AdapterSignalV2 =
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

export interface AdapterCapabilityProfileV2 {
  format: "harnery-v2-adapter-capabilities";
  format_version: 1;
  adapter: Adapter;
  signals: Record<AdapterSignalV2, CapabilitySupportV2>;
}

const SHARED = {
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

export const ADAPTER_CAPABILITY_PROFILES_V2: Record<Adapter, AdapterCapabilityProfileV2> = {
  "claude-code": {
    format: "harnery-v2-adapter-capabilities",
    format_version: 1,
    adapter: "claude-code",
    signals: {
      ...SHARED,
      session_end: "native",
      turn_id: "conditional",
      permission: "native",
      post_compaction: "native",
    },
  },
  codex: {
    format: "harnery-v2-adapter-capabilities",
    format_version: 1,
    adapter: "codex",
    signals: {
      ...SHARED,
      session_end: "unsupported",
      turn_id: "native",
      permission: "native",
      post_compaction: "native",
    },
  },
  cursor: {
    format: "harnery-v2-adapter-capabilities",
    format_version: 1,
    adapter: "cursor",
    signals: {
      ...SHARED,
      session_end: "native",
      turn_id: "unsupported",
      permission: "conditional",
      post_compaction: "unsupported",
    },
  },
};

export function adapterCapabilityProfileV2(adapter: Adapter): AdapterCapabilityProfileV2 {
  return ADAPTER_CAPABILITY_PROFILES_V2[adapter];
}

export function adapterCapabilityProfileDigestV2(adapter: Adapter): `cap_${string}` {
  return `cap_${sha256V2(canonicalJsonV2(adapterCapabilityProfileV2(adapter))).slice(7)}`;
}

export function adapterSignalSupportV2(
  adapter: Adapter,
  signal: AdapterSignalV2,
): CapabilitySupportV2 {
  return adapterCapabilityProfileV2(adapter).signals[signal];
}
