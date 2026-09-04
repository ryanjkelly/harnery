import { describe, expect, test } from "bun:test";
import frozenDigests from "./__fixtures__/event-adapter-capability-digests.json";
import { EVENT_ADAPTER_IDS_V3 } from "./adapter-id.ts";
import {
  ADAPTER_CAPABILITY_PROFILES_V3,
  ADAPTER_WAIT_KINDS_V3,
  adapterCapabilityProfileDigestV3,
  adapterDurationSupportV3,
  adapterSignalSupportV3,
  adapterTurnWaitCountSupportV3,
  adapterWaitCoverageMatrixV3,
  adapterWaitKindSupportV3,
  cursorToolChannelSupportV3,
} from "./capabilities.ts";

describe("event ledger V3 adapter capabilities", () => {
  test("declares economics and drift support for every adapter", () => {
    for (const adapter of EVENT_ADAPTER_IDS_V3) {
      const profile = ADAPTER_CAPABILITY_PROFILES_V3[adapter];
      expect(profile.adapter).toBe(adapter);
      expect(profile.format).toBe("harnery-v3-adapter-capabilities");
      expect(profile.signals.harness_timing).toBe(
        adapter === "openclaw" ? "unsupported" : "derived",
      );
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

  test("declares context support at the fidelity each local adapter can prove", () => {
    expect(adapterSignalSupportV3("claude-code", "context_usage")).toBe("conditional");
    expect(adapterSignalSupportV3("codex", "context_usage")).toBe("derived");
    expect(adapterSignalSupportV3("cursor", "context_usage")).toBe("conditional");
  });

  test("admits the current native lifecycle hooks", () => {
    expect(adapterSignalSupportV3("codex", "session_end")).toBe("native");
    expect(adapterSignalSupportV3("cursor", "pre_compaction")).toBe("native");
  });

  test("does not claim timing that OpenClaw hooks do not emit", () => {
    expect(adapterSignalSupportV3("openclaw", "harness_timing")).toBe("unsupported");
    expect(adapterSignalSupportV3("openclaw", "tool_duration")).toBe("unsupported");
    expect(adapterSignalSupportV3("openclaw", "inference_timing")).toBe("unsupported");
    expect(adapterDurationSupportV3("openclaw", "turn_duration")).toBe("unsupported");
    expect(adapterDurationSupportV3("openclaw", "tool_duration")).toBe("unsupported");
    expect(adapterDurationSupportV3("codex", "turn_duration")).toBe("derived");
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
    for (const adapter of EVENT_ADAPTER_IDS_V3) {
      const first = adapterCapabilityProfileDigestV3(adapter);
      expect(first).toMatch(/^cap_[a-f0-9]{64}$/);
      expect(adapterCapabilityProfileDigestV3(adapter)).toBe(first);
      expect(String(first)).toBe(frozenDigests[adapter]);
    }
  });

  test("keeps the three published digests byte-identical after adding OpenClaw", () => {
    expect(frozenDigests).toMatchObject({
      "claude-code": "cap_da5b432e1d0e86c679875b78c988d50929e67d6533cb64b55b09078f77cadb3e",
      codex: "cap_9d30ad47121d63dced21e48ef6ddea0d706001f54abe67062957a7a3c209b681",
      cursor: "cap_5cbd92cdbd362caf711d924d3d68599a44ebc5e2dc7ca5de2b9e7a5286ba24f6",
    });
  });

  test("separates observable permission waits from unattested turn completeness", () => {
    expect(adapterWaitKindSupportV3("claude-code", "permission")).toBe("native");
    expect(adapterWaitKindSupportV3("codex", "permission")).toBe("native");
    expect(adapterWaitKindSupportV3("cursor", "permission")).toBe("conditional");
    expect(adapterWaitKindSupportV3("openclaw", "permission")).toBe("unsupported");
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
