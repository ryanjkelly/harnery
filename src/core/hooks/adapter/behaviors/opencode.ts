import type { AdapterBehavior } from "./types.ts";

/**
 * OpenCode: events arrive through the Harnery plugin bridging to agent-hook.
 * No host-side effects, no exit-code enforcement, no effort dial.
 */
export const opencodeBehavior: AdapterBehavior = {
  id: "opencode",
  sessionStartPlatformLabel: "OpenCode",
  soundEffects: false,
  journalMaintenance: false,
  sessionTelemetrySync: false,
  promptPresenceDetection: false,
  promptContextNudges: {
    taskNudge: false,
    hostPromptReminder: false,
    statusFooterNudge: false,
    turnRitualNudge: undefined,
  },
  completedResponseEvent: undefined,
  sessionIdentityOnStartOnly: false,
  nativeTurnIdOptional: false,
  tracksExecutionMode: false,
  shellOperationDedup: false,
  promptMayPrecedeSessionStart: false,
  promptContinuesOpenTurn: false,
  turnRecovery: false,
  nativeTelemetryOnly: false,
  runtimeContextTranscriptOptional: false,
  runtimeContextRetry: false,
  effortAttestation: "none",
  transcriptTuningRefresh: false,
  modelProvider: "opencode",
  runtimeContextAvailable: () => true,
  bridgeFor: () => undefined,
};
