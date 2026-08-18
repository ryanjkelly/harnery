/**
 * Command/narration event emitter for the coordination layer.
 *
 * `writeSessionEvent` records command spans in the canonical V2 ledger.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// Kept dependency-light: vendored verbatim into a downstream consumer, so no coordEnv import.
import {
  LIVE_COMMAND_V2_PRODUCER_ID,
  liveInstanceIdV2,
  livePlatformV2,
  resolveLiveEventLedgerRouteV2,
} from "../events/v2/live-routing.ts";
import type { CommandObservationV2, CommandSignalV2 } from "../events/v2/producers/command.ts";
import { recordCommandSignalV2 } from "../events/v2/producers/command-recorder.ts";
import { writeProducerDiagnosticV2 } from "../events/v2/producers/intake.ts";
import { readHookProducerStateByInstanceV2 } from "../events/v2/producers/recorder.ts";
import { resolveEmitRoot } from "./canonical-emit.ts";

/** Event types accepted by `writeSessionEvent`. */
export type SessionEventType = "command_start" | "output" | "command_end" | "narration";

/**
 * Resolved path of the ndjson sidecar file. Lives inside `.harnery/` so a
 * containerized reader can pick it up through a single bind mount.
 */
export function coordinationRootPath(): string {
  const root = resolveEmitRoot();
  return root ?? resolve(process.env.HOME || "/tmp");
}

/** Random 8-char hex id for grouping output lines under a single command. */
export function newCmdId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Read the model's most recent `<intent>...</intent>` declaration from the
 * intent-stamp file written by the PreToolUse hook. Returns null when the
 * file is missing, empty, or contains the explicit `(no intent)` sentinel.
 * Callers fall back to whatever default they want in that case.
 *
 * Path: `.harnery/.last-intent.<instance_id>` next to the agent's heartbeat.
 */
export function readLastIntent(instanceId?: string): string | null {
  if (!instanceId) return null;
  // Same superproject-aware root resolution as coordinationRootPath(): the
  // intent stamp is written by the PreToolUse hook into the SUPERPROJECT's
  // .harnery/, so a nested-`.harnery/` cwd must not redirect the read.
  const root = resolveEmitRoot();
  if (!root) return null;
  const agentsDir = resolve(root, ".harnery");
  const intentPath = resolve(agentsDir, `.last-intent.${instanceId}`);
  if (!existsSync(intentPath)) return null;
  try {
    const raw = readFileSync(intentPath, "utf8").trim();
    if (!raw || raw === "(no intent)") return null;
    return raw;
  } catch {
    return null;
  }
}

const CANONICAL_TYPE: Record<SessionEventType, string> = {
  command_start: "command.start",
  output: "command.output",
  command_end: "command.end",
  narration: "narration",
};

const outputSequence = new Map<string, number>();

/** Emit a command/narration event to the canonical stream. Swallows every
 * error and skips when identity can't be resolved: telemetry must never break
 * or slow down a command. */
function emitCanonicalCommand(type: SessionEventType, fields: Record<string, unknown>): void {
  const eventType = CANONICAL_TYPE[type];
  if (!eventType) return;
  const instanceId = typeof fields.instance_id === "string" ? fields.instance_id : undefined;
  if (!instanceId) return;
  try {
    const coordRoot = coordinationRootPath();
    const route = resolveLiveEventLedgerRouteV2(coordRoot);
    if (route.state === "blocked" || type === "narration") return;
    const liveInstanceId = liveInstanceIdV2(instanceId);
    const hook = readHookProducerStateByInstanceV2(coordRoot, liveInstanceId);
    if (!hook) {
      writeProducerDiagnosticV2(coordRoot, "command_emit_unjoinable", {
        type,
        instance_id: instanceId,
        reason: "hook_generation_not_found",
      });
      return;
    }
    const command = commandSignalAndObservation(type, fields);
    if (!command) return;
    const result = recordCommandSignalV2({
      coordRoot,
      mode: route.mode,
      signal: command.signal,
      observation: command.observation,
      adapter: hook.adapter,
      instance_id: liveInstanceId,
      producer_id: LIVE_COMMAND_V2_PRODUCER_ID,
      build_id: route.build_id,
      platform: livePlatformV2(),
      ...(fields.bridge === "codex-wsl" ? { bridge: "codex-wsl" as const } : {}),
      monotonic_ns: process.hrtime.bigint().toString(),
    });
    if (result.state === "generation_unavailable") {
      writeProducerDiagnosticV2(coordRoot, "command_emit_unjoinable", {
        type,
        instance_id: instanceId,
        signal: command.signal,
        reason: result.reason,
      });
    } else if (result.state !== "recorded" && result.state !== "already_recorded") {
      writeProducerDiagnosticV2(coordRoot, "command_emit_rejected", {
        type,
        instance_id: instanceId,
        signal: command.signal,
        result_state: result.state,
      });
    }
  } catch (error) {
    // Telemetry must never break the command, but the loss is preserved.
    try {
      const coordRoot = coordinationRootPath();
      writeProducerDiagnosticV2(coordRoot, "command_emit_failed", {
        type,
        instance_id: instanceId,
        error: String(error),
      });
    } catch {
      /* diagnostics are best-effort */
    }
  }
}

function commandSignalAndObservation(
  type: Exclude<SessionEventType, "narration">,
  fields: Record<string, unknown>,
): { signal: CommandSignalV2; observation: CommandObservationV2 } | undefined {
  const commandId = typeof fields.cmd_id === "string" ? fields.cmd_id : undefined;
  if (!commandId) return undefined;
  if (type === "command_start") {
    outputSequence.set(commandId, 0);
    const command = typeof fields.cmd === "string" ? fields.cmd : "";
    const executable = command.trim().split(/\s+/, 1)[0] || "unknown";
    return {
      signal: "command-start",
      observation: {
        native_command_id: commandId,
        executable,
        executable_class: "cli",
        // This module runs inside the command process, so preserve the actual
        // argument boundaries for the HMAC instead of hashing a clamped line.
        argv: process.argv.slice(2),
        intent: typeof fields.intent === "string" ? fields.intent : undefined,
        intent_kind: typeof fields.intent === "string" ? "declared" : "unknown",
        sensitive_argument_count: 0,
      },
    };
  }
  if (type === "output") {
    const sequence = (outputSequence.get(commandId) ?? 0) + 1;
    outputSequence.set(commandId, sequence);
    const line = typeof fields.line === "string" ? fields.line : "";
    const stream =
      fields.stream === "stdout" || fields.stream === "stderr" ? fields.stream : "combined";
    return {
      signal: "command-output",
      observation: {
        native_command_id: commandId,
        native_observation_id: `${commandId}:output:${sequence}`,
        stream,
        output: line,
        output_bytes: Buffer.byteLength(line, "utf8"),
        output_lines: line ? 1 : 0,
      },
    };
  }
  outputSequence.delete(commandId);
  const exitCode =
    typeof fields.exit === "number" && Number.isSafeInteger(fields.exit) ? fields.exit : undefined;
  return {
    signal: "command-completed",
    observation: {
      native_command_id: commandId,
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      outcome: exitCode === undefined ? "unknown" : exitCode === 0 ? "succeeded" : "failed",
      duration_ms:
        typeof fields.duration_ms === "number" && fields.duration_ms >= 0
          ? fields.duration_ms
          : undefined,
      signal: typeof fields.signal === "string" ? fields.signal : undefined,
    },
  };
}

/**
 * Record a command event in V2. Best-effort, never throws into the caller;
 * telemetry must not break or slow a command.
 */
export function writeSessionEvent(
  type: SessionEventType,
  fields: Record<string, unknown> = {},
): void {
  emitCanonicalCommand(type, fields);
}

/** Trim long values to keep individual events small. */
export function clampField(v: string, max = 1024): string {
  if (v.length <= max) return v;
  return `${v.slice(0, max - 1)}…`;
}
