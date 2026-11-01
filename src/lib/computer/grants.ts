/**
 * Desktop-control approvals for `harn computer` (ADR 0230).
 *
 * In an ask mode, an agent needs a live approval before it may take the
 * desktop. An approval is its own record, separate from the lease: the lease
 * says who holds the desktop right now and lapses after a short idle period;
 * an approval says a person agreed to one agent using the desktop, for one
 * stated purpose or one session, until it ends.
 *
 * - `task` approvals end at `expires_at` (the project's `grant_minutes`), when
 *   the agent finishes (`computer done`) or releases the desktop, or when the
 *   person revokes them.
 * - `session` approvals last for the agent's session, capped at
 *   `SESSION_GRANT_MAX_MS`, until revoked.
 *
 * Records live beside the lease (`<desktop state>/computer/grants.json`), so
 * every caller of one desktop sees them, and every decision is appended to
 * `grants-log.ndjson` there. Both are plain files any process running as the
 * desktop's user can write: approvals are a cooperative check on a
 * well-meaning agent, not a security boundary against one that sets out to
 * get around them.
 *
 * Internal module: not exported from package.json.
 */
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The longest a session approval lasts before the person is asked again. */
export const SESSION_GRANT_MAX_MS = 12 * 60 * 60 * 1000;
/** How long a task approval lasts when the project sets no `grant_minutes`. */
export const DEFAULT_TASK_GRANT_MINUTES = 20;

const GRANTS_FILE = "grants.json";
const LOG_FILE = "grants-log.ndjson";
const LOCK_DIR = "grants.lock";
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;

export type GrantKind = "task" | "session";

/** How the person answered: a dialog on the desktop or a prompt in their terminal. */
export type GrantChannel = "dialog" | "terminal";

export interface DesktopGrant {
  id: string;
  owner_id: string;
  owner_label: string;
  project?: string;
  kind: GrantKind;
  purpose: string;
  granted_at: string;
  expires_at: string;
  approved_via: GrantChannel;
}

export type GrantEvent =
  | "requested"
  | "approved"
  | "denied"
  | "timed-out"
  | "unavailable"
  | "ended"
  | "revoked"
  | "mode-changed";

export interface GrantLogEntry {
  at: string;
  event: GrantEvent;
  owner_id?: string;
  owner_label?: string;
  project?: string;
  kind?: GrantKind;
  purpose?: string;
  via?: GrantChannel;
  detail?: string;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` holding the grants lock (an atomic mkdir; a stale lock is broken). */
function withLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, LOCK_DIR);
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error(`timed out waiting for ${lock}`);
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function isGrant(value: unknown): value is DesktopGrant {
  if (!value || typeof value !== "object") return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g.id === "string" &&
    typeof g.owner_id === "string" &&
    typeof g.owner_label === "string" &&
    (g.kind === "task" || g.kind === "session") &&
    typeof g.purpose === "string" &&
    typeof g.granted_at === "string" &&
    typeof g.expires_at === "string" &&
    !Number.isNaN(Date.parse(g.expires_at))
  );
}

/** Every stored approval, expired ones included; malformed entries are dropped. */
export function readGrants(dir: string): DesktopGrant[] {
  try {
    const value = JSON.parse(readFileSync(join(dir, GRANTS_FILE), "utf8")) as { grants?: unknown };
    return Array.isArray(value.grants) ? value.grants.filter(isGrant) : [];
  } catch {
    return [];
  }
}

function writeGrants(dir: string, grants: DesktopGrant[]): void {
  const target = join(dir, GRANTS_FILE);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ schema: 1, grants }, null, 2)}\n`);
  renameSync(tmp, target);
}

/** The owner's unexpired approval in this project, if any. */
export function liveGrant(
  dir: string,
  ownerId: string,
  project: string | undefined,
  nowMs: number,
): DesktopGrant | undefined {
  return readGrants(dir).find(
    (g) =>
      g.owner_id === ownerId &&
      (g.project ?? null) === (project ?? null) &&
      Date.parse(g.expires_at) > nowMs,
  );
}

/** Store a new approval, replacing any earlier one for the same owner and project. */
export function addGrant(
  dir: string,
  grant: Omit<DesktopGrant, "id" | "granted_at" | "expires_at">,
  options: { nowMs: number; durationMs: number },
): DesktopGrant {
  const record: DesktopGrant = {
    id: randomUUID(),
    ...grant,
    granted_at: new Date(options.nowMs).toISOString(),
    expires_at: new Date(options.nowMs + options.durationMs).toISOString(),
  };
  withLock(dir, () => {
    const kept = readGrants(dir).filter(
      (g) =>
        Date.parse(g.expires_at) > options.nowMs &&
        !(g.owner_id === grant.owner_id && (g.project ?? null) === (grant.project ?? null)),
    );
    writeGrants(dir, [...kept, record]);
  });
  return record;
}

/**
 * End approvals and return the ones removed. `ownerId` limits it to one owner
 * (all owners when omitted); `kind` to one kind. Expired records are dropped
 * along the way.
 */
export function endGrants(
  dir: string,
  options: { nowMs: number; ownerId?: string; project?: string; kind?: GrantKind },
): DesktopGrant[] {
  return withLock(dir, () => {
    const all = readGrants(dir);
    const ended: DesktopGrant[] = [];
    const kept: DesktopGrant[] = [];
    for (const g of all) {
      if (Date.parse(g.expires_at) <= options.nowMs) continue;
      const matches =
        (options.ownerId === undefined || g.owner_id === options.ownerId) &&
        (options.project === undefined || (g.project ?? null) === options.project) &&
        (options.kind === undefined || g.kind === options.kind);
      (matches ? ended : kept).push(g);
    }
    if (ended.length > 0 || kept.length !== all.length) writeGrants(dir, kept);
    return ended;
  });
}

/** Append one decision to the approvals log. Never throws: the log must not block desktop work. */
export function logGrantEvent(dir: string, entry: Omit<GrantLogEntry, "at">, nowMs: number): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, LOG_FILE),
      `${JSON.stringify({ at: new Date(nowMs).toISOString(), ...entry })}\n`,
    );
  } catch {
    // Best effort.
  }
}
