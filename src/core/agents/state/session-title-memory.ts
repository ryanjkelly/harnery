/**
 * Durable per-session memory of the session's title state.
 *
 * The title fields (`suggested_session_name`, the display latch, and the
 * title-surface stamps) live only in the disposable heartbeat cache at
 * `.harnery/active/<instance_id>.json`; they never enter the V3 ledger. The
 * stale sweep deletes that cache once a session has been idle past the
 * freshness window (600 s by default), and the cache is then rebuilt from the
 * ledger on the session's next hook. Without this memory the rebuilt row has
 * no title, so the next `set-task` mints a fresh `Agent <name> - <task>` and a
 * writing surface such as T3 Code renames the thread mid-session, breaking the
 * start-and-done-only rule (ADR 0086, ADR 0247).
 *
 * Each cache write that changes a title field mirrors those fields here, keyed
 * by the same instance id. The sweep leaves these files alone; they are pruned
 * only after `SESSION_TITLE_MEMORY_RETENTION_SECONDS` without a change. A
 * rebuild or a row read with no cache recalls the fields from here when the
 * native session and agent identity still match.
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.ts";
import type { Heartbeat } from "./heartbeat-reader.ts";

/** The heartbeat fields that make up a session's title state. */
export const SESSION_TITLE_FIELDS = [
  "suggested_session_name",
  "session_name_seen_for",
  "session_name_seen_at",
  "session_name_display_requested_for",
  "session_name_display_reminders",
  "session_title_surface",
  "session_title_client_thread",
  "session_title_applied_for",
  "session_title_fallback_for",
] as const;

type SessionTitleField = (typeof SESSION_TITLE_FIELDS)[number];
export type SessionTitleFields = Partial<Pick<Heartbeat, SessionTitleField>>;

export interface SessionTitleMemory extends SessionTitleFields {
  instance_id: string;
  session_id: string;
  name?: string;
}

/** Thirty days: longer than any session the operator keeps open. */
export const SESSION_TITLE_MEMORY_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function memoryDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "session-titles");
}

function memoryPath(coordRoot: string, instanceId: string): string | null {
  if (!SAFE_ID.test(instanceId) || instanceId.startsWith(".")) return null;
  return join(memoryDir(coordRoot), `${instanceId}.json`);
}

/** The title fields present on `row`, or an empty object. */
export function sessionTitleFields(row: Partial<Heartbeat> | null | undefined): SessionTitleFields {
  const out: Record<string, unknown> = {};
  if (!row) return out as SessionTitleFields;
  for (const field of SESSION_TITLE_FIELDS) {
    const value = row[field];
    if (value !== undefined && value !== null && value !== "") out[field] = value;
  }
  return out as SessionTitleFields;
}

function sameFields(a: SessionTitleFields, b: SessionTitleFields): boolean {
  return SESSION_TITLE_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Mirror `next`'s title fields when they differ from `prior`'s. Best effort:
 * a failure here never blocks the cache write it accompanies.
 */
export function rememberSessionTitle(
  coordRoot: string,
  prior: Partial<Heartbeat> | null | undefined,
  next: Partial<Heartbeat>,
): void {
  try {
    const instanceId = next.instance_id;
    const sessionId = next.session_id;
    if (!instanceId || !sessionId) return;
    const fields = sessionTitleFields(next);
    if (Object.keys(fields).length === 0) return;
    if (prior && prior.session_id === sessionId && sameFields(sessionTitleFields(prior), fields)) {
      return;
    }
    const path = memoryPath(coordRoot, instanceId);
    if (!path) return;
    const memory: SessionTitleMemory = {
      instance_id: instanceId,
      session_id: sessionId,
      ...(next.name ? { name: next.name } : {}),
      ...fields,
    };
    atomicWrite(path, JSON.stringify(memory, null, 2));
  } catch {
    /* best effort */
  }
}

/**
 * The remembered title fields for this instance, when they belong to the same
 * native session and the agent identity has not changed. A reassumed name
 * would make the old `Agent <name> - …` title wrong for the new owner, so a
 * different known name returns nothing.
 */
export function recallSessionTitle(
  coordRoot: string,
  instanceId: string,
  sessionId: string | undefined,
  agentName: string | undefined,
): SessionTitleFields {
  try {
    const path = memoryPath(coordRoot, instanceId);
    if (!path || !existsSync(path)) return {};
    const memory = JSON.parse(readFileSync(path, "utf8")) as SessionTitleMemory;
    if (memory.instance_id !== instanceId) return {};
    if (sessionId && memory.session_id !== sessionId) return {};
    if (agentName && memory.name && memory.name !== agentName) return {};
    return sessionTitleFields(memory as Partial<Heartbeat>);
  } catch {
    return {};
  }
}

/** Delete memories unchanged for longer than the retention window. */
export function pruneSessionTitleMemory(
  coordRoot: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  retentionSecs: number = SESSION_TITLE_MEMORY_RETENTION_SECONDS,
): number {
  const dir = memoryDir(coordRoot);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    try {
      if (Math.floor(statSync(path).mtimeMs / 1000) < nowSec - retentionSecs) {
        unlinkSync(path);
        removed += 1;
      }
    } catch {
      /* swallow */
    }
  }
  return removed;
}
