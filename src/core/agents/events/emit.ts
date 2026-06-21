/**
 * Canonical-event writer for agent-coord. Mirrors the agent-hooks emitter:
 * both modules write the same envelope shape to the same
 * `.harnery/events.ndjson` file but stay independent (shared code limited to
 * event/schema types).
 *
 * Phase 4: agent-coord uses this from CLI handlers (state.task_set,
 * state.status_checked, state.scratch_append, council.*, presence.*).
 */

import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { ulid } from "./ulid.ts";

const SCHEMA_VERSION = 1 as const;
const STREAM_FILE = ".harnery/events.ndjson";
const LOCK_FILE = ".harnery/events.ndjson.lock";
const MAX_LINE_BYTES = 64 * 1024;

export type Harness = "claude-code" | "cursor" | "codex";
export type Source = "agent-hooks" | "agent-coord" | "user" | "system";

export interface Envelope {
  schema_version: typeof SCHEMA_VERSION;
  event_id: string;
  event_type: string;
  ts: string;
  instance_id: string;
  session_id: string;
  parent_session_id?: string;
  turn_id?: string;
  parent_turn_id?: string;
  harness: Harness;
  source: Source;
  data: Record<string, unknown>;
}

export interface EmitInput {
  event_type: string;
  instance_id: string;
  session_id: string;
  harness: Harness;
  source?: Source;
  parent_session_id?: string;
  turn_id?: string;
  parent_turn_id?: string;
  ts?: string;
  data: Record<string, unknown>;
}

export function buildEnvelope(input: EmitInput): Envelope {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: ulid(),
    event_type: input.event_type,
    ts: input.ts ?? new Date().toISOString(),
    instance_id: input.instance_id,
    session_id: input.session_id,
    parent_session_id: input.parent_session_id,
    turn_id: input.turn_id,
    parent_turn_id: input.parent_turn_id,
    harness: input.harness,
    source: input.source ?? "agent-coord",
    data: input.data,
  };
}

export function emit(coordRoot: string, input: EmitInput): Envelope {
  const envelope = buildEnvelope(input);
  const streamPath = join(coordRoot, STREAM_FILE);
  const lockPath = join(coordRoot, LOCK_FILE);

  ensureDir(dirname(streamPath));
  ensureFile(lockPath);

  let line = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    line = `${JSON.stringify({
      ...envelope,
      data: { __over_size_limit: true, original_bytes: Buffer.byteLength(line, "utf8") },
    })}\n`;
  }

  const lockFd = openSync(lockPath, "r+");
  try {
    appendFileSync(streamPath, line, { encoding: "utf8", flag: "a" });
  } finally {
    closeSync(lockFd);
  }

  return envelope;
}

function ensureDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch {
    /* swallow */
  }
}

function ensureFile(path: string): void {
  try {
    closeSync(openSync(path, "a"));
  } catch {
    /* swallow */
  }
}
