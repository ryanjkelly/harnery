import { describe, expect, test } from "bun:test";
import { EVENT_ADAPTER_IDS_V3 } from "../../../events/v3/adapter-id.ts";
import { ADAPTER_BEHAVIORS, adapterBehavior } from "./index.ts";

describe("adapter behaviors", () => {
  test("every event adapter id has a behavior whose id matches the key", () => {
    for (const id of EVENT_ADAPTER_IDS_V3) {
      expect(adapterBehavior(id).id).toBe(id);
    }
    expect(Object.keys(ADAPTER_BEHAVIORS).sort()).toEqual([...EVENT_ADAPTER_IDS_V3].sort());
  });

  test("host-side effects are Claude Code only", () => {
    for (const id of EVENT_ADAPTER_IDS_V3) {
      const b = adapterBehavior(id);
      const isClaude = id === "claude-code";
      expect(b.soundEffects).toBe(isClaude);
      expect(b.journalMaintenance).toBe(isClaude);
      expect(b.sessionTelemetrySync).toBe(isClaude);
      expect(b.promptPresenceDetection).toBe(isClaude);
      expect(b.promptContextNudges.turnRitualNudge).toBe(isClaude ? "claude-code" : undefined);
    }
  });

  test("prompt-context nudges match the previous per-adapter flags", () => {
    expect(adapterBehavior("cursor").promptContextNudges).toEqual({
      taskNudge: true,
      hostPromptReminder: true,
      statusFooterNudge: false,
      turnRitualNudge: undefined,
    });
    expect(adapterBehavior("codex").promptContextNudges).toEqual({
      taskNudge: true,
      hostPromptReminder: true,
      statusFooterNudge: true,
      turnRitualNudge: undefined,
    });
    expect(adapterBehavior("opencode").promptContextNudges).toEqual({
      taskNudge: false,
      hostPromptReminder: false,
      statusFooterNudge: false,
      turnRitualNudge: undefined,
    });
  });

  test("session-start labels: host default for Claude Code, named otherwise", () => {
    expect(adapterBehavior("claude-code").sessionStartPlatformLabel).toBeUndefined();
    expect(adapterBehavior("cursor").sessionStartPlatformLabel).toBe("Cursor");
    expect(adapterBehavior("codex").sessionStartPlatformLabel).toBe("Codex");
    expect(adapterBehavior("opencode").sessionStartPlatformLabel).toBe("OpenCode");
  });

  test("only Codex reports a bridge, and only for a WSL UNC cwd", () => {
    expect(adapterBehavior("codex").bridgeFor("\\\\wsl.localhost\\Ubuntu\\home\\x")).toBe(
      "codex-wsl",
    );
    expect(adapterBehavior("codex").bridgeFor("/home/x")).toBeUndefined();
    for (const id of EVENT_ADAPTER_IDS_V3) {
      if (id === "codex") continue;
      expect(adapterBehavior(id).bridgeFor("\\\\wsl.localhost\\Ubuntu\\home\\x")).toBeUndefined();
      expect(adapterBehavior(id).unsafeCrossShellReason).toBeUndefined();
      expect(adapterBehavior(id).discoverTranscript).toBeUndefined();
    }
  });

  test("runtime context availability follows execution mode and adapter", () => {
    expect(adapterBehavior("cursor").runtimeContextAvailable("cloud")).toBe(false);
    expect(adapterBehavior("cursor").runtimeContextAvailable("local")).toBe(true);
    expect(adapterBehavior("cursor").runtimeContextAvailable(undefined)).toBe(true);
    expect(adapterBehavior("openclaw").runtimeContextAvailable(undefined)).toBe(false);
    expect(adapterBehavior("codex").runtimeContextAvailable(undefined)).toBe(true);
  });

  test("model providers and effort attestation sources", () => {
    expect(adapterBehavior("claude-code").modelProvider).toBe("anthropic");
    expect(adapterBehavior("codex").modelProvider).toBe("openai");
    expect(adapterBehavior("cursor").modelProvider).toBe("cursor");
    expect(adapterBehavior("codex").effortAttestation).toBe("rollout-probe");
    expect(adapterBehavior("claude-code").effortAttestation).toBe("payload");
    expect(adapterBehavior("cursor").effortAttestation).toBe("payload");
    expect(adapterBehavior("opencode").effortAttestation).toBe("none");
  });

  test("Cursor supplies inline assistant text on tool hooks", () => {
    expect(
      adapterBehavior("cursor").inlineAssistantText?.({ raw: {}, agent_message: "hello" }),
    ).toBe("hello");
    expect(adapterBehavior("codex").inlineAssistantText).toBeUndefined();
  });

  test("producer-side turn flags match the previous per-adapter branches", () => {
    for (const id of EVENT_ADAPTER_IDS_V3) {
      const b = adapterBehavior(id);
      const isCursor = id === "cursor";
      expect(b.sessionIdentityOnStartOnly).toBe(isCursor);
      expect(b.nativeTurnIdOptional).toBe(isCursor);
      expect(b.tracksExecutionMode).toBe(isCursor);
      expect(b.shellOperationDedup).toBe(isCursor);
      expect(b.promptMayPrecedeSessionStart).toBe(isCursor);
      expect(b.promptContinuesOpenTurn).toBe(isCursor);
      expect(b.runtimeContextTranscriptOptional).toBe(isCursor);
      expect(b.completedResponseEvent).toBe(isCursor ? "after-agent-response" : undefined);
      expect(b.runtimeContextRetry).toBe(id === "codex");
      expect(b.transcriptTuningRefresh).toBe(id === "claude-code");
      expect(b.nativeTelemetryOnly).toBe(id === "openclaw");
      // Recovery stays off for OpenCode until its onboarding is certified.
      expect(b.turnRecovery).toBe(id !== "opencode");
    }
  });

  test("Codex owns the mid-flight diagnostic context and transcript verification", () => {
    const codex = adapterBehavior("codex");
    expect(codex.midFlightDiagnosticContext?.({ raw: {}, session_id: "abc" })).toMatchObject({
      identity_recovery_source: "native_session_id",
    });
    expect(codex.discoverTranscript?.("not-a-session-id")).toBeUndefined();
    for (const id of EVENT_ADAPTER_IDS_V3) {
      if (id === "codex") continue;
      expect(adapterBehavior(id).midFlightDiagnosticContext).toBeUndefined();
    }
  });
});
