import { describe, expect, test } from "bun:test";
import {
  ADAPTER_CAPABILITY_PROFILES_V3,
  ADAPTER_WAIT_KINDS_V3,
  adapterCapabilityProfileDigestV3,
  adapterSignalSupportV3,
  adapterTurnWaitCountSupportV3,
  adapterWaitCoverageMatrixV3,
  adapterWaitKindSupportV3,
  cursorToolChannelSupportV3,
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

  test("keeps usage conditional but marks native hook inference timing unsupported", () => {
    for (const adapter of ["claude-code", "codex"] as const) {
      expect(adapterSignalSupportV3(adapter, "model_usage")).toBe("conditional");
      expect(adapterSignalSupportV3(adapter, "inference_timing")).toBe("unsupported");
    }
    expect(adapterSignalSupportV3("cursor", "model_usage")).toBe("unsupported");
    expect(adapterSignalSupportV3("cursor", "inference_timing")).toBe("unsupported");
  });

  test("does not promise context usage absent from current terminal hooks", () => {
    for (const adapter of ["claude-code", "codex", "cursor"] as const) {
      expect(adapterSignalSupportV3(adapter, "context_usage")).toBe("unsupported");
    }
  });

  test("admits the current native lifecycle hooks", () => {
    expect(adapterSignalSupportV3("codex", "session_end")).toBe("native");
    expect(adapterSignalSupportV3("cursor", "pre_compaction")).toBe("native");
  });

  test("declares Cursor tool coverage conditional and resolves it by execution mode", () => {
    for (const signal of [
      "tool_request",
      "tool_result",
      "tool_failure",
      "tool_call_id",
      "tool_duration",
      "shell",
    ] as const) {
      expect(adapterSignalSupportV3("cursor", signal)).toBe("conditional");
    }
    expect(cursorToolChannelSupportV3("local")).toBe("native");
    expect(cursorToolChannelSupportV3("cloud")).toBe("unsupported");
    expect(cursorToolChannelSupportV3("unknown")).toBe("conditional");
  });

  test("produces stable V3 capability digests", () => {
    for (const adapter of ["claude-code", "codex", "cursor"] as const) {
      const first = adapterCapabilityProfileDigestV3(adapter);
      expect(first).toMatch(/^cap_[a-f0-9]{64}$/);
      expect(adapterCapabilityProfileDigestV3(adapter)).toBe(first);
    }
  });

  test("separates observable permission waits from unattested turn completeness", () => {
    expect(adapterWaitKindSupportV3("claude-code", "permission")).toBe("native");
    expect(adapterWaitKindSupportV3("codex", "permission")).toBe("native");
    expect(adapterWaitKindSupportV3("cursor", "permission")).toBe("conditional");
    expect(adapterWaitKindSupportV3("claude-code", "scheduled")).toBe("unsupported");
    expect(adapterTurnWaitCountSupportV3("claude-code")).toBe("unsupported");
    expect(adapterTurnWaitCountSupportV3("codex")).toBe("unsupported");
    expect(adapterTurnWaitCountSupportV3("cursor")).toBe("unsupported");
  });

  test("publishes a complete per-kind matrix without promoting observed spans to completeness", () => {
    for (const adapter of ["claude-code", "codex", "cursor"] as const) {
      const matrix = adapterWaitCoverageMatrixV3(adapter);
      expect(Object.keys(matrix)).toEqual([...ADAPTER_WAIT_KINDS_V3]);
      for (const kind of ADAPTER_WAIT_KINDS_V3) {
        expect(matrix[kind].turn_completeness).toBe("unsupported");
      }
      expect(matrix.permission.span_delivery).toBe(adapter === "cursor" ? "conditional" : "native");
      expect(matrix.needs_input.span_delivery).toBe("unsupported");
      expect(matrix.decision.span_delivery).toBe("unsupported");
      expect(matrix.approval.span_delivery).toBe("unsupported");
      expect(matrix.scheduled.span_delivery).toBe("unsupported");
      expect(matrix.rate_limit.span_delivery).toBe("unsupported");
      expect(matrix.unknown.span_delivery).toBe("unsupported");
    }
  });
});
