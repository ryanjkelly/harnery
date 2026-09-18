/**
 * Command/narration event emitter for the coordination layer.
 *
 * `writeSessionEvent` records command spans in the canonical V3 ledger.
 */

import { createHash, type Hash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// Kept dependency-light: vendored verbatim into a downstream consumer, so no coordEnv import.
import {
  LIVE_COMMAND_V3_PRODUCER_ID,
  liveInstanceIdV3,
  livePlatformV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import type { CommandObservationV3, CommandSignalV3 } from "../events/v3/producers/command.ts";
import { recordCommandSignalV3 } from "../events/v3/producers/command-recorder.ts";
import { writeProducerDiagnosticV3 } from "../events/v3/producers/intake.ts";
import { readHookProducerStateByInstanceV3 } from "../events/v3/producers/recorder.ts";
import { resolveEmitRoot } from "./canonical-emit.ts";

/** Event types accepted by `writeSessionEvent`. */
export type SessionEventType = "command.started" | "command.output_observed" | "command.completed";

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

type OutputStream = "stdout" | "stderr" | "combined";

interface OutputSummary {
  stream: OutputStream;
  bytes: number;
  lines: number;
  chunks: number;
  hash: Hash;
}

interface PendingCommand {
  coordRoot: string;
  fields: Record<string, unknown>;
  streams: Map<OutputStream, OutputSummary>;
}

const pendingCommands = new Map<string, PendingCommand>();
let exitFlushInstalled = false;

function commandKey(fields: Record<string, unknown>): string | undefined {
  return typeof fields.instance_id === "string" && typeof fields.cmd_id === "string"
    ? JSON.stringify([fields.instance_id, fields.cmd_id])
    : undefined;
}

function flushCommandOutput(command: PendingCommand): void {
  for (const summary of command.streams.values()) {
    recordCommandObservation("command.output_observed", command.fields, command.coordRoot, summary);
  }
  command.streams.clear();
}

/** Emit a command/narration event to the canonical stream. Swallows every
 * error and skips when identity can't be resolved: telemetry must never break
 * or slow down a command. */
function recordCommandObservation(
  type: SessionEventType,
  fields: Record<string, unknown>,
  coordRoot: string,
  summary?: OutputSummary,
): boolean {
  const instanceId = typeof fields.instance_id === "string" ? fields.instance_id : undefined;
  if (!instanceId) return false;
  try {
    const route = resolveLiveEventLedgerRouteV3(coordRoot);
    if (route.state === "blocked") return false;
    const liveInstanceId = liveInstanceIdV3(instanceId);
    const hook = readHookProducerStateByInstanceV3(coordRoot, liveInstanceId);
    if (!hook) {
      writeProducerDiagnosticV3(coordRoot, "command_emit_unjoinable", {
        type,
        instance_id: instanceId,
        reason: "hook_generation_not_found",
      });
      return false;
    }
    const command = commandSignalAndObservation(type, fields, summary);
    if (!command) return false;
    const result = recordCommandSignalV3({
      coordRoot,
      mode: route.mode,
      signal: command.signal,
      observation: command.observation,
      adapter: hook.adapter,
      instance_id: liveInstanceId,
      producer_id: LIVE_COMMAND_V3_PRODUCER_ID,
      build_id: route.build_id,
      platform: livePlatformV3(),
      ...(fields.bridge === "codex-wsl" ? { bridge: "codex-wsl" as const } : {}),
      monotonic_ns: process.hrtime.bigint().toString(),
    });
    if (result.state === "generation_unavailable") {
      const expectedLifecycleReopenGap =
        result.reason === "turn_not_started" &&
        hook.session_start_derivation === "approved_lifecycle_reopen";
      if (expectedLifecycleReopenGap) return false;
      writeProducerDiagnosticV3(coordRoot, "command_emit_unjoinable", {
        type,
        instance_id: instanceId,
        signal: command.signal,
        reason: result.reason,
      });
    } else if (result.state !== "recorded" && result.state !== "already_recorded") {
      writeProducerDiagnosticV3(coordRoot, "command_emit_rejected", {
        type,
        instance_id: instanceId,
        signal: command.signal,
        result_state: result.state,
      });
    }
    return result.state === "recorded" || result.state === "already_recorded";
  } catch (error) {
    // Telemetry must never break the command, but the loss is preserved.
    try {
      writeProducerDiagnosticV3(coordRoot, "command_emit_failed", {
        type,
        instance_id: instanceId,
        error: String(error),
      });
    } catch {
      /* diagnostics are best-effort */
    }
    return false;
  }
}

/** Count the non-empty lines in one output chunk; a single event may carry many. */
export function countOutputLines(text: string): number {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split("\n")) if (line.length > 0) count += 1;
  return count;
}

function commandSignalAndObservation(
  type: SessionEventType,
  fields: Record<string, unknown>,
  summary?: OutputSummary,
): { signal: CommandSignalV3; observation: CommandObservationV3 } | undefined {
  const commandId = typeof fields.cmd_id === "string" ? fields.cmd_id : undefined;
  if (!commandId) return undefined;
  if (type === "command.started") {
    const command = typeof fields.cmd === "string" ? fields.cmd : "";
    const executable = command.trim().split(/\s+/, 1)[0] || "unknown";
    return {
      signal: "command.started",
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
  if (type === "command.output_observed") {
    if (!summary) return undefined;
    return {
      signal: "command.output_observed",
      observation: {
        native_command_id: commandId,
        native_observation_id: `${commandId}:output-summary:${summary.stream}`,
        stream: summary.stream,
        // The normalizer HMACs this bounded descriptor with the generation key.
        // Neither raw output nor its unkeyed digest is written to the ledger.
        output: {
          format: "harnery-command-output-chunks-v1",
          chunks: summary.chunks,
          sha256: summary.hash.digest("hex"),
        },
        output_bytes: summary.bytes,
        output_lines: summary.lines,
      },
    };
  }
  const exitCode =
    typeof fields.exit === "number" && Number.isSafeInteger(fields.exit) ? fields.exit : undefined;
  return {
    signal: "command.completed",
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
 * Start/completion use the durable V3 recorder. Output only updates bounded
 * per-stream counters and hashes; summaries flush before completion or at
 * process exit. A forced kill can lose unflushed summaries (ADR 0188).
 * Best-effort: telemetry never throws into the caller.
 */
export function writeSessionEvent(
  type: SessionEventType,
  fields: Record<string, unknown> = {},
): void {
  try {
    const key = commandKey(fields);
    if (!key) return;
    if (type === "command.output_observed") {
      const command = pendingCommands.get(key);
      if (!command) return;
      const stream =
        fields.stream === "stdout" || fields.stream === "stderr" ? fields.stream : "combined";
      let summary = command.streams.get(stream);
      if (!summary) {
        summary = { stream, bytes: 0, lines: 0, chunks: 0, hash: createHash("sha256") };
        command.streams.set(stream, summary);
      }
      const line = typeof fields.line === "string" ? fields.line : "";
      const normalized = line.normalize("NFC");
      // Length framing preserves chunk boundaries, including empty chunks.
      summary.hash.update(`${Buffer.byteLength(normalized, "utf8")}:`).update(normalized);
      summary.bytes += Buffer.byteLength(line, "utf8");
      summary.lines += countOutputLines(line);
      summary.chunks += 1;
      return;
    }
    const command = pendingCommands.get(key);
    const coordRoot = command?.coordRoot ?? coordinationRootPath();
    if (type === "command.completed") {
      pendingCommands.delete(key);
      if (command) flushCommandOutput(command);
      recordCommandObservation(type, fields, coordRoot);
    } else if (recordCommandObservation(type, fields, coordRoot) && !command) {
      pendingCommands.set(key, {
        coordRoot,
        fields: {
          instance_id: fields.instance_id,
          cmd_id: fields.cmd_id,
          bridge: fields.bridge,
        },
        streams: new Map(),
      });
      if (!exitFlushInstalled) {
        exitFlushInstalled = true;
        process.once("exit", () => {
          for (const pending of pendingCommands.values()) flushCommandOutput(pending);
          pendingCommands.clear();
        });
      }
    }
  } catch {
    // Root resolution and in-memory bookkeeping must not break the command.
  }
}

/** Trim long values to keep individual events small. */
export function clampField(v: string, max = 1024): string {
  if (v.length <= max) return v;
  return `${v.slice(0, max - 1)}…`;
}
