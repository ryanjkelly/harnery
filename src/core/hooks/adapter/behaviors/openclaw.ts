import type { AdapterBehavior } from "./types.ts";

/**
 * OpenClaw: event-only. Its plugin bundles the V3 producer and never runs the
 * hook CLI, so every hook-process effect is off and telemetry is native only.
 */
export const openclawBehavior: AdapterBehavior = {
  id: "openclaw",
  sessionStartPlatformLabel: undefined,
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
  turnRecovery: true,
  nativeTelemetryOnly: true,
  runtimeContextTranscriptOptional: false,
  runtimeContextRetry: false,
  effortAttestation: "none",
  transcriptTuningRefresh: false,
  modelProvider: "openclaw",
  runtimeContextAvailable: () => false,
  bridgeFor: () => undefined,
};
