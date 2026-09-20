import { resolveBinName } from "../../../config.ts";
import {
  codexWslFileLinkTelemetry,
  inspectCodexWslBridge,
  isWslUncPath,
  renderCodexWslFileLinkContext,
} from "../../codex-wsl-bridge.ts";
import { unsafeCrossShellReason } from "../../unsafe-cross-shell.ts";
import { discoverCodexSessionTranscript } from "../runtime-telemetry.ts";
import type { AdapterBehavior } from "./types.ts";

/**
 * Codex: hook payloads omit `transcript_path`, so the rollout is discovered by
 * session id; effort is probed from the rollout; a Windows-native Codex over a
 * WSL UNC workspace is the one bridged deployment Harnery knows about.
 */
export const codexBehavior: AdapterBehavior = {
  id: "codex",
  sessionStartPlatformLabel: "Codex",
  soundEffects: false,
  journalMaintenance: false,
  sessionTelemetrySync: false,
  promptPresenceDetection: false,
  promptContextNudges: {
    taskNudge: true,
    hostPromptReminder: true,
    statusFooterNudge: true,
    turnRitualNudge: undefined,
  },
  completedResponseEvent: undefined,
  sessionIdentityOnStartOnly: false,
  nativeTurnIdOptional: false,
  tracksExecutionMode: false,
  shellOperationDedup: false,
  nativeTelemetryOnly: false,
  runtimeContextTranscriptOptional: false,
  runtimeContextRetry: true,
  effortAttestation: "rollout-probe",
  modelProvider: "openai",
  runtimeContextAvailable: () => true,
  bridgeFor: (cwd) => (isWslUncPath(cwd) ? "codex-wsl" : undefined),
  discoverTranscript: (nativeSessionId) => discoverCodexSessionTranscript(nativeSessionId),
  fileLinkTelemetry: (coordRoot, cwd, lastAssistantMessage) =>
    codexWslFileLinkTelemetry(coordRoot, cwd, lastAssistantMessage),
  fileLinkContext: (coordRoot, cwd) => renderCodexWslFileLinkContext(coordRoot, cwd),
  bridgeWarning: (coordRoot, cwd) => {
    if (!isWslUncPath(cwd)) return undefined;
    const bridge = inspectCodexWslBridge(process.env, { expected: true });
    if (!bridge || bridge.ok) return undefined;
    return `Harnery hybrid warning: ${bridge.detail}. Run \`${resolveBinName(coordRoot)} doctor\` for the repair hint.`;
  },
  unsafeCrossShellReason: (input) => unsafeCrossShellReason({ adapter: "codex", ...input }),
};
