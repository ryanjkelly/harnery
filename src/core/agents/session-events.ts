/**
 * Command/narration event emitter for the coordination layer.
 *
 * `writeSessionEvent` emits command + narration events straight to the
 * **canonical** `.harnery/events.ndjson` (alongside the hook events), which the
 * `/live` web viewer reads. The exported surface (`writeSessionEvent`,
 * `newCmdId`, `clampField`, `readLastIntent`) is stable so the session-tee
 * middleware callers need no edits.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
// Kept dependency-light: vendored verbatim into a downstream consumer, so no coordEnv import.
import { normalizeHarness, resolveEmitRoot } from "./canonical-emit.ts";
import { emit } from "./events/emit.ts";

/** Event types accepted by `writeSessionEvent`. Only the command stream +
 * narration are emitted canonically; the coord/state types are accepted for
 * call-site compatibility but are no-ops (the agents CLI emits those itself). */
export type SessionEventType =
  | "command_start"
  | "output"
  | "command_end"
  | "end_of_turn"
  | "hook_event"
  | "set_task"
  | "file_claim"
  | "file_release"
  | "peer_change"
  | "narration";

/**
 * Resolved path of the ndjson sidecar file. Lives inside `.harnery/` so a
 * containerized reader can pick it up through a single bind mount.
 */
export function sessionEventsPath(): string {
  // Explicit override (tests + non-monorepo invocations).
  const explicit = process.env.HARNERY_OUTPUT_SESSION_EVENTS;
  if (explicit) return explicit;
  // Superproject-aware root resolution (git first, cwd walk fallback) via
  // resolveEmitRoot. A plain cwd walk here mis-anchored to a NESTED
  // `.harnery/` when the shell sat inside a submodule carrying its own
  // (e.g. an embedded harnery checkout), silently splitting the event
  // stream. Don't reintroduce CLAUDE.md / .git as anchors, which creates
  // stray .harnery/ dirs under submodule subtrees.
  const root = resolveEmitRoot();
  if (root) return resolve(root, ".harnery", "session-events.ndjson");
  return resolve(process.env.HOME || "/tmp", ".harnery", "session-events.ndjson");
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
  // Same superproject-aware root resolution as sessionEventsPath(): the
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

/**
 * Dual-write: mirror command/narration session-events
 * into the canonical `.harnery/events.ndjson` stream so the legacy
 * session-events.ndjson writer + its web consumers can be retired.
 * Only the command-stream + narration types migrate; the coord/state types
 * (`set_task`, `file_claim`, `peer_change`, …) are already emitted canonically
 * by the agents CLI, so re-emitting them here would double-count.
 */
const CANONICAL_TYPE: Partial<Record<SessionEventType, string>> = {
  command_start: "command.start",
  output: "command.output",
  command_end: "command.end",
  narration: "narration",
};

interface HeartbeatEnrichment {
  session_id: string;
  harness: "claude-code" | "cursor" | "codex";
  at: number;
}
/** Cache heartbeat-derived envelope fields per instance_id so a burst of
 * `output` lines (one event per stdout line) doesn't re-read + re-parse the
 * heartbeat JSON each time. Short TTL: picks up platform/session changes
 * within a few seconds without hammering the disk on a chatty command. */
const enrichCache = new Map<string, HeartbeatEnrichment>();
const ENRICH_TTL_MS = 5000;

function enrichFromHeartbeat(coordRoot: string, instanceId: string): HeartbeatEnrichment | null {
  const now = Date.now();
  const cached = enrichCache.get(instanceId);
  if (cached && now - cached.at < ENRICH_TTL_MS) return cached;
  try {
    const hbPath = resolve(coordRoot, ".harnery", "active", `${instanceId}.json`);
    if (!existsSync(hbPath)) return null;
    const hb = JSON.parse(readFileSync(hbPath, "utf8")) as {
      session_id?: string;
      platform?: string;
    };
    const enrichment: HeartbeatEnrichment = {
      session_id: hb.session_id || instanceId,
      harness: normalizeHarness(hb.platform),
      at: now,
    };
    enrichCache.set(instanceId, enrichment);
    return enrichment;
  } catch {
    return null;
  }
}

/** Project the flat legacy `fields` into the canonical event's `data` shape.
 * Unknown types never reach here, guarded by CANONICAL_TYPE. */
function canonicalData(
  type: SessionEventType,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case "command_start":
      return { cmd_id: fields.cmd_id, intent: fields.intent, cmd: fields.cmd };
    case "output":
      return { cmd_id: fields.cmd_id, stream: fields.stream, line: fields.line };
    case "command_end":
      return {
        cmd_id: fields.cmd_id,
        exit: fields.exit,
        duration_ms: fields.duration_ms,
        ...(fields.signal ? { signal: fields.signal } : {}),
      };
    case "narration":
      return { message: fields.message };
    default:
      return {};
  }
}

/** Emit a command/narration event to the canonical stream. Swallows every
 * error and skips when identity can't be resolved: telemetry must never break
 * (or slow down) a command. Non-command types return early. */
function emitCanonicalCommand(type: SessionEventType, fields: Record<string, unknown>): void {
  const eventType = CANONICAL_TYPE[type];
  if (!eventType) return;
  const instanceId = typeof fields.instance_id === "string" ? fields.instance_id : undefined;
  if (!instanceId) return;
  try {
    // coordRoot = the dir containing `.harnery/`; sessionEventsPath() anchors it.
    const coordRoot = dirname(dirname(sessionEventsPath()));
    const enrich = enrichFromHeartbeat(coordRoot, instanceId);
    if (!enrich) return;
    emit(coordRoot, {
      event_type: eventType,
      instance_id: instanceId,
      session_id: enrich.session_id,
      harness: enrich.harness,
      data: canonicalData(type, fields),
    });
  } catch {
    /* telemetry only, never break the command */
  }
}

/**
 * Emit a session event. Command + narration events
 * are written to the canonical `.harnery/events.ndjson`; the coord/state types
 * are accepted for call-site compatibility but are no-ops here (the agents CLI
 * emits those itself). Best-effort, never throws into the caller; a command
 * must never break or slow on telemetry. The `agentName` arg is retained for
 * the stable call signature (canonical events key on instance_id, not name).
 */
export function writeSessionEvent(
  type: SessionEventType,
  _agentName: string,
  fields: Record<string, unknown> = {},
): void {
  emitCanonicalCommand(type, fields);
}

/** Trim long values to keep individual events small. */
export function clampField(v: string, max = 1024): string {
  if (v.length <= max) return v;
  return `${v.slice(0, max - 1)}…`;
}
