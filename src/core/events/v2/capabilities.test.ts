import { describe, expect, test } from "bun:test";
import {
  ADAPTER_CAPABILITY_PROFILES_V2,
  adapterCapabilityProfileDigestV2,
  adapterSignalSupportV2,
} from "./capabilities.ts";

describe("event ledger V2 adapter capability profiles", () => {
  test("keys every active adapter with a deterministic contract-shaped digest", () => {
    expect(Object.keys(ADAPTER_CAPABILITY_PROFILES_V2).sort()).toEqual([
      "claude-code",
      "codex",
      "cursor",
    ]);
    for (const adapter of ["claude-code", "codex", "cursor"] as const) {
      expect(adapterCapabilityProfileDigestV2(adapter)).toMatch(/^cap_[a-f0-9]{64}$/);
      expect(adapterCapabilityProfileDigestV2(adapter)).toBe(
        adapterCapabilityProfileDigestV2(adapter),
      );
    }
  });

  test("records harness gaps instead of equalizing adapters", () => {
    expect(adapterSignalSupportV2("codex", "session_end")).toBe("unsupported");
    expect(adapterSignalSupportV2("cursor", "post_compaction")).toBe("unsupported");
    expect(adapterSignalSupportV2("cursor", "permission")).toBe("conditional");
    expect(adapterSignalSupportV2("claude-code", "session_end")).toBe("native");
    expect(adapterSignalSupportV2("claude-code", "tool_duration")).toBe("derived");
  });
});
