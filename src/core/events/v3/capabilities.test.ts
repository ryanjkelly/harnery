import { describe, expect, test } from "bun:test";
import {
  ADAPTER_CAPABILITY_PROFILES_V3,
  adapterCapabilityProfileDigestV3,
  adapterSignalSupportV3,
} from "./capabilities.ts";

describe("event ledger V3 adapter capabilities", () => {
  test("declares economics and drift support for every adapter", () => {
    for (const adapter of ["claude-code", "codex", "cursor"] as const) {
      const profile = ADAPTER_CAPABILITY_PROFILES_V3[adapter];
      expect(profile.adapter).toBe(adapter);
      expect(profile.format).toBe("harnery-v3-adapter-capabilities");
      expect(profile.signals.harness_timing).toBe("derived");
      expect(profile.signals.capability_drift).toBe("derived");
      expect(profile.signals).toHaveProperty("model_usage");
      expect(profile.signals).toHaveProperty("inference_timing");
    }
  });

  test("makes provider economics conditional and Cursor economics unsupported", () => {
    for (const adapter of ["claude-code", "codex"] as const) {
      expect(adapterSignalSupportV3(adapter, "model_usage")).toBe("conditional");
      expect(adapterSignalSupportV3(adapter, "inference_timing")).toBe("conditional");
    }
    expect(adapterSignalSupportV3("cursor", "model_usage")).toBe("unsupported");
    expect(adapterSignalSupportV3("cursor", "inference_timing")).toBe("unsupported");
  });

  test("admits the current native lifecycle hooks", () => {
    expect(adapterSignalSupportV3("codex", "session_end")).toBe("native");
    expect(adapterSignalSupportV3("cursor", "pre_compaction")).toBe("native");
  });

  test("produces stable V3 capability digests", () => {
    for (const adapter of ["claude-code", "codex", "cursor"] as const) {
      const first = adapterCapabilityProfileDigestV3(adapter);
      expect(first).toMatch(/^cap_[a-f0-9]{64}$/);
      expect(adapterCapabilityProfileDigestV3(adapter)).toBe(first);
    }
  });
});
