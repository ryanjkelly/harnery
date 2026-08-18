import type { Adapter } from "../../adapter.ts";
import { ADAPTER_CAPABILITY_PROFILES_V2 } from "../v2/capabilities.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";

export type CapabilitySupportV3 = "native" | "derived" | "conditional" | "unsupported";

export type AdapterSignalV3 =
  | keyof (typeof ADAPTER_CAPABILITY_PROFILES_V2)["claude-code"]["signals"]
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

function profile(
  adapter: Adapter,
  economics: Pick<Record<AdapterSignalV3, CapabilitySupportV3>, "model_usage" | "inference_timing">,
): AdapterCapabilityProfileV3 {
  return {
    format: "harnery-v3-adapter-capabilities",
    format_version: 1,
    adapter,
    signals: {
      ...ADAPTER_CAPABILITY_PROFILES_V2[adapter].signals,
      ...economics,
      harness_timing: "derived",
      capability_drift: "derived",
    },
  };
}

export const ADAPTER_CAPABILITY_PROFILES_V3: Record<Adapter, AdapterCapabilityProfileV3> = {
  "claude-code": profile("claude-code", {
    model_usage: "conditional",
    inference_timing: "conditional",
  }),
  codex: profile("codex", {
    model_usage: "conditional",
    inference_timing: "conditional",
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
