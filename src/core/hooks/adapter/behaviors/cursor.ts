import type { AdapterBehavior } from "./types.ts";

/**
 * Cursor: no exit-code enforcement, a separate afterAgentResponse hook carries
 * the completed reply, and cloud mode has no readable runtime context.
 */
export const cursorBehavior: AdapterBehavior = {
  id: "cursor",
  sessionStartPlatformLabel: "Cursor",
  soundEffects: false,
  journalMaintenance: false,
  sessionTelemetrySync: false,
  promptPresenceDetection: false,
  promptContextNudges: {
    taskNudge: true,
    hostPromptReminder: true,
    statusFooterNudge: false,
    turnRitualNudge: undefined,
  },
  completedResponseEvent: "after-agent-response",
  sessionIdentityOnStartOnly: true,
  nativeTurnIdOptional: true,
  tracksExecutionMode: true,
  shellOperationDedup: true,
  promptMayPrecedeSessionStart: true,
  promptContinuesOpenTurn: true,
  turnRecovery: true,
  nativeTelemetryOnly: false,
  runtimeContextTranscriptOptional: true,
  runtimeContextRetry: false,
  effortAttestation: "payload",
  transcriptTuningRefresh: false,
  modelProvider: "cursor",
  runtimeContextAvailable: (mode) => mode !== "cloud",
  bridgeFor: () => undefined,
  inlineAssistantText: (payload) => payload?.agent_message,
};
