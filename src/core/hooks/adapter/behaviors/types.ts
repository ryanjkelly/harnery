import type { Adapter } from "../../../adapter.ts";
import type { EventAdapterIdV3 } from "../../../events/v3/adapter-id.ts";
import type { CodexWslFileLinkTelemetry } from "../../codex-wsl-bridge.ts";
import type { ParsedPayload } from "../parse.ts";
import type { RuntimeTelemetryOptions } from "../runtime-telemetry.ts";

/** Flags passed to the prompt-context renderer on every user prompt. */
export interface PromptContextNudges {
  taskNudge: boolean;
  hostPromptReminder: boolean;
  statusFooterNudge: boolean;
  turnRitualNudge: Adapter | undefined;
}

/** Inputs for the cross-shell safety inspection on a tool request. */
export interface CrossShellInput {
  cwd: unknown;
  toolName: string | undefined;
  toolInput: unknown;
}

/** Where a producer learns the effective effort/speed dial from. */
export type EffortAttestationSource = "payload" | "rollout-probe" | "none";

/**
 * Everything the hook CLI and the V3 producer decide per adapter. Each
 * adapter owns one module under this directory; `adapterBehavior(id)` is the
 * only lookup, so the middle of the pipeline never branches on an adapter id.
 *
 * Every field is a decision the shared code used to make with an equality
 * check. Booleans are effect gates, strings are labels, and the optional
 * methods are adapter-native helpers that only exist for that adapter.
 */
export interface AdapterBehavior {
  readonly id: EventAdapterIdV3;

  // ── Session-boundary effects ────────────────────────────────────────────
  /** Label shown in the session-start context; `undefined` means the host default. */
  readonly sessionStartPlatformLabel: string | undefined;
  /** The hook process plays notification sounds (kill-switch independent). */
  readonly soundEffects: boolean;
  /** Journal janitor at start, recovery cue in the start context, archive at end. */
  readonly journalMaintenance: boolean;
  /** Session telemetry sync extension at session end and on stop. */
  readonly sessionTelemetrySync: boolean;
  /** Presence (mobile vs office) is inferred from the submitted prompt text. */
  readonly promptPresenceDetection: boolean;
  readonly promptContextNudges: PromptContextNudges;

  // ── Turn correlation in the V3 producer ─────────────────────────────────
  /** Hook event that carries the completed assistant reply, when stop lacks it. */
  readonly completedResponseEvent: string | undefined;
  /** Native session identity arrives only on the start signal; later hooks join by instance. */
  readonly sessionIdentityOnStartOnly: boolean;
  /** A terminal or telemetry probe may proceed without a native turn id. */
  readonly nativeTurnIdOptional: boolean;
  /** The producer tracks a native execution mode (local/cloud) in its state. */
  readonly tracksExecutionMode: boolean;
  /** Shell hooks may deliver the same command twice; dedupe by a command fingerprint. */
  readonly shellOperationDedup: boolean;
  /** The native prompt signal can arrive before session start and is a trusted boundary. */
  readonly promptMayPrecedeSessionStart: boolean;
  /** A prompt signal inside an open turn continues that turn instead of starting a new one. */
  readonly promptContinuesOpenTurn: boolean;
  /** Missed hook signals may be recovered into derived turns and spans. */
  readonly turnRecovery: boolean;

  // ── Runtime telemetry ───────────────────────────────────────────────────
  /** Turn telemetry comes only from the native payload; no runtime transcript read. */
  readonly nativeTelemetryOnly: boolean;
  /** Runtime context telemetry does not require a transcript path. */
  readonly runtimeContextTranscriptOptional: boolean;
  /** Late runtime-context samples are retried after stop (rollout flush lag). */
  readonly runtimeContextRetry: boolean;
  readonly effortAttestation: EffortAttestationSource;
  /** After a payload effort change, refresh speed and model from the transcript row. */
  readonly transcriptTuningRefresh: boolean;
  /** Provider label attached to attested model identity. */
  readonly modelProvider: string;
  /** Whether runtime context can be read at all under the given execution mode. */
  runtimeContextAvailable(executionMode: string | undefined): boolean;

  // ── Deployment bridge ───────────────────────────────────────────────────
  /** Bridge descriptor stamped on events when the payload cwd shows a bridged deployment. */
  bridgeFor(cwd: unknown): "codex-wsl" | undefined;

  // ── Adapter-native helpers (present only where the adapter needs them) ──
  /** Locate (or verify) the session transcript when hook payloads omit `transcript_path`. */
  discoverTranscript?(
    nativeSessionId: string,
    candidate?: string,
    options?: RuntimeTelemetryOptions,
  ): string | undefined;
  /** Privacy-safe environment provenance recorded when a session onboards mid-flight. */
  midFlightDiagnosticContext?(payload: ParsedPayload): Record<string, string | boolean>;
  /** Completed-reply text supplied inline on tool hooks (no transcript needed). */
  inlineAssistantText?(payload: ParsedPayload | null): string | undefined;
  /** Extra turn.completed telemetry about file links under a bridged deployment. */
  fileLinkTelemetry?(
    coordRoot: string,
    cwd: unknown,
    lastAssistantMessage: string,
  ): CodexWslFileLinkTelemetry | null;
  /** Context block teaching the agent how file links resolve under a bridge. */
  fileLinkContext?(coordRoot: string, cwd: unknown): string;
  /** Warning appended to the session-start context when the bridge is misconfigured. */
  bridgeWarning?(coordRoot: string, cwd: unknown): string | undefined;
  /** Deny reason for a tool call whose shell shape is unsafe under the bridge. */
  unsafeCrossShellReason?(input: CrossShellInput): string | null;
}
