import { resolveBinName } from "../../../config.ts";
import {
  codexWslFileLinkTelemetry,
  inspectCodexWslBridge,
  isWslUncPath,
  renderCodexWslFileLinkContext,
} from "../../codex-wsl-bridge.ts";
import { unsafeCrossShellReason } from "../../unsafe-cross-shell.ts";
import type { ParsedPayload } from "../parse.ts";
import { discoverCodexSessionTranscript } from "../runtime-telemetry.ts";
import type { AdapterBehavior } from "./types.ts";

/**
 * Privacy-safe environment and recovery provenance for Codex mid-flight
 * onboarding. WSLENV values are never recorded, only normalized variable
 * names, and the native session identifier itself remains fingerprinted.
 */
export function codexMidFlightDiagnosticContext(
  payload: ParsedPayload,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | boolean> {
  const wslenv = env.WSLENV?.trim() ?? "";
  const wslenvNames = [
    ...new Set(
      wslenv
        .split(":")
        .map((entry) => entry.split("/", 1)[0]?.trim() ?? "")
        .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)),
    ),
  ]
    .sort()
    .join(":")
    .slice(0, 512);
  const identityRecoverySource = payload.session_id
    ? "native_session_id"
    : payload.conversation_id
      ? "native_conversation_id"
      : payload.agent_id
        ? "native_agent_id"
        : "unavailable";
  return {
    thread_id_present: Boolean(env.CODEX_THREAD_ID?.trim()),
    wslenv_present: wslenv.length > 0,
    wslenv_names: wslenvNames,
    identity_recovery_source: identityRecoverySource,
  };
}

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
  promptMayPrecedeSessionStart: false,
  promptContinuesOpenTurn: false,
  turnRecovery: true,
  nativeTelemetryOnly: false,
  runtimeContextTranscriptOptional: false,
  runtimeContextRetry: true,
  effortAttestation: "rollout-probe",
  transcriptTuningRefresh: false,
  modelProvider: "openai",
  runtimeContextAvailable: () => true,
  bridgeFor: (cwd) => (isWslUncPath(cwd) ? "codex-wsl" : undefined),
  discoverTranscript: (nativeSessionId, candidate, options) =>
    discoverCodexSessionTranscript(nativeSessionId, candidate, options),
  midFlightDiagnosticContext: (payload) => codexMidFlightDiagnosticContext(payload),
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
