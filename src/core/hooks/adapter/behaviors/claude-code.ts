import type { AdapterBehavior } from "./types.ts";

/** Claude Code: the reference adapter; host-default labels, full effect set. */
export const claudeCodeBehavior: AdapterBehavior = {
  id: "claude-code",
  sessionStartPlatformLabel: undefined,
  soundEffects: true,
  journalMaintenance: true,
  sessionTelemetrySync: true,
  promptPresenceDetection: true,
  promptContextNudges: {
    taskNudge: false,
    hostPromptReminder: false,
    statusFooterNudge: false,
    turnRitualNudge: "claude-code",
  },
  completedResponseEvent: undefined,
  sessionIdentityOnStartOnly: false,
  nativeTurnIdOptional: false,
  tracksExecutionMode: false,
  shellOperationDedup: false,
  nativeTelemetryOnly: false,
  runtimeContextTranscriptOptional: false,
  runtimeContextRetry: false,
  effortAttestation: "payload",
  modelProvider: "anthropic",
  runtimeContextAvailable: () => true,
  bridgeFor: () => undefined,
};
