/**
 * Persistent state for project self-update: `state.json` (last run, converged
 * point, notices, per-session delivery) and the `run.lock` directory that keeps
 * one runner per checkout.
 *
 * Writers re-read the file immediately before writing (`mutateAutoUpdateState`)
 * because a long run and the prompt hooks that deliver notices both update it.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { isHeldLockFailure, type LockDirSeam, realLockDirSeam } from "../../lib/held-lock.ts";
import {
  AUTOUPDATE_FILES,
  type AutoUpdateConfig,
  type AutoUpdateNotice,
  type AutoUpdateState,
  type NoticeKind,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTICE_DEDUPE_MS = DAY_MS;
const NOTICE_KEEP = 20;
const NEW_SESSION_WINDOW_MS = DAY_MS;
const DELIVERED_PRUNE_MS = 7 * DAY_MS;

export function autoUpdateDir(coordRoot: string): string {
  return join(resolve(coordRoot), AUTOUPDATE_FILES.dir);
}

export function autoUpdateStatePath(coordRoot: string): string {
  return join(autoUpdateDir(coordRoot), AUTOUPDATE_FILES.state);
}

export function autoUpdateStampPath(coordRoot: string): string {
  return join(autoUpdateDir(coordRoot), AUTOUPDATE_FILES.stamp);
}

export function autoUpdateLockPath(coordRoot: string): string {
  return join(autoUpdateDir(coordRoot), AUTOUPDATE_FILES.lock);
}

/** The run log lives with the other Harnery logs, not in private state. */
export function autoUpdateLogPath(coordRoot: string): string {
  return join(resolve(coordRoot), ".harnery", "logs", AUTOUPDATE_FILES.log);
}

export function freshAutoUpdateState(): AutoUpdateState {
  return { schema: 1, notices: [], delivered: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotice(value: unknown): value is AutoUpdateNotice {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.at === "string" &&
    typeof value.kind === "string" &&
    typeof value.text === "string"
  );
}

/** Read state; a missing or corrupt file yields fresh state. */
export function readAutoUpdateState(coordRoot: string): AutoUpdateState {
  let raw: string;
  try {
    raw = readFileSync(autoUpdateStatePath(coordRoot), "utf8");
  } catch {
    return freshAutoUpdateState();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.schema !== 1) return freshAutoUpdateState();
    const state = parsed as unknown as AutoUpdateState;
    const notices = Array.isArray(parsed.notices) ? parsed.notices.filter(isNotice) : [];
    const delivered: Record<string, string> = {};
    if (isRecord(parsed.delivered)) {
      for (const [key, at] of Object.entries(parsed.delivered)) {
        if (typeof at === "string") delivered[key] = at;
      }
    }
    return { ...state, schema: 1, notices, delivered };
  } catch {
    return freshAutoUpdateState();
  }
}

/** Write state atomically (temp file + rename). */
export function writeAutoUpdateState(coordRoot: string, state: AutoUpdateState): void {
  const dir = autoUpdateDir(coordRoot);
  mkdirSync(dir, { recursive: true });
  const target = autoUpdateStatePath(coordRoot);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  try {
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Re-read, apply `mutate`, write. Returns the written state. */
export function mutateAutoUpdateState(
  coordRoot: string,
  mutate: (state: AutoUpdateState) => void,
): AutoUpdateState {
  const state = readAutoUpdateState(coordRoot);
  mutate(state);
  writeAutoUpdateState(coordRoot, state);
  return state;
}

function noticeId(kind: NoticeKind, text: string, at: string): string {
  return createHash("sha1").update(`${kind}\n${text}\n${at}`).digest("hex").slice(0, 12);
}

/**
 * Append a notice to `state` in place. The same kind and text within 24 hours
 * is not repeated; only the newest 20 notices are kept. Returns the notice now
 * on record (the earlier one when deduplicated).
 */
export function addNotice(
  state: AutoUpdateState,
  kind: NoticeKind,
  text: string,
  now: number = Date.now(),
): AutoUpdateNotice {
  const existing = state.notices.find(
    (n) => n.kind === kind && n.text === text && now - Date.parse(n.at) < NOTICE_DEDUPE_MS,
  );
  if (existing) return existing;
  const at = new Date(now).toISOString();
  const notice: AutoUpdateNotice = { id: noticeId(kind, text, at), at, kind, text };
  state.notices.push(notice);
  if (state.notices.length > NOTICE_KEEP) {
    state.notices = state.notices.slice(state.notices.length - NOTICE_KEEP);
  }
  return notice;
}

/**
 * Notices this session has not seen yet, marked delivered. A session key with
 * no record sees only the last 24 hours. Cheap when there is nothing to say:
 * no write happens unless a notice is returned.
 */
export function pendingNotices(
  coordRoot: string,
  sessionKey: string,
  now: number = Date.now(),
): AutoUpdateNotice[] {
  const state = readAutoUpdateState(coordRoot);
  if (state.notices.length === 0) return [];
  const since = state.delivered[sessionKey];
  const cutoff = since ?? new Date(now - NEW_SESSION_WINDOW_MS).toISOString();
  const fresh = state.notices.filter((n) => (since ? n.at > cutoff : n.at >= cutoff));
  if (fresh.length === 0) return [];
  const newest = fresh.reduce((max, n) => (n.at > max ? n.at : max), fresh[0]?.at ?? "");
  mutateAutoUpdateState(coordRoot, (s) => {
    const prior = s.delivered[sessionKey];
    if (!prior || newest > prior) s.delivered[sessionKey] = newest;
    for (const [key, at] of Object.entries(s.delivered)) {
      const ms = Date.parse(at);
      if (key !== sessionKey && (!Number.isFinite(ms) || now - ms > DELIVERED_PRUNE_MS)) {
        delete s.delivered[key];
      }
    }
  });
  return fresh;
}

// ---------------------------------------------------------------- run lock

export interface LockOwner {
  pid: number;
  at: string;
  host?: string;
}

/** Minutes after which a held lock counts as abandoned. */
export function lockStaleMinutes(
  cfg: Pick<AutoUpdateConfig, "timeoutMinutes" | "steps" | "dailySteps">,
): number {
  return cfg.timeoutMinutes * Math.max(1, cfg.steps.length + cfg.dailySteps.length) + 5;
}

export interface LockInspection {
  held: boolean;
  stale: boolean;
  owner: LockOwner | null;
  ageMs: number | null;
}

/** Inspect the lock without taking it. One stat when free. */
export function inspectLock(
  coordRoot: string,
  cfg: Pick<AutoUpdateConfig, "timeoutMinutes" | "steps" | "dailySteps">,
  now: number = Date.now(),
): LockInspection {
  const lockDir = autoUpdateLockPath(coordRoot);
  let dirMtime: number;
  try {
    dirMtime = statSync(lockDir).mtimeMs;
  } catch {
    return { held: false, stale: false, owner: null, ageMs: null };
  }
  let owner: LockOwner | null = null;
  try {
    const parsed = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.pid === "number" && typeof parsed.at === "string") {
      owner = {
        pid: parsed.pid,
        at: parsed.at,
        ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
      };
    }
  } catch {
    owner = null;
  }
  const since = owner ? Date.parse(owner.at) : dirMtime;
  const ageMs = now - (Number.isFinite(since) ? since : dirMtime);
  const stale = ageMs > lockStaleMinutes(cfg) * 60_000;
  return { held: true, stale, owner, ageMs };
}

export type LockAttempt =
  | { acquired: true; release: () => void }
  | { acquired: false; owner: LockOwner | null };

/** Take the run lock, breaking it once when it is stale. */
export function acquireRunLock(
  coordRoot: string,
  cfg: Pick<AutoUpdateConfig, "timeoutMinutes" | "steps" | "dailySteps">,
  now: number = Date.now(),
  seam: LockDirSeam = realLockDirSeam,
): LockAttempt {
  mkdirSync(autoUpdateDir(coordRoot), { recursive: true });
  const lockDir = autoUpdateLockPath(coordRoot);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      seam.mkdir(lockDir);
    } catch (err) {
      if (!isHeldLockFailure(err, seam)) throw err;
      const inspection = inspectLock(coordRoot, cfg, now);
      if (!inspection.stale || attempt > 0) return { acquired: false, owner: inspection.owner };
      rmSync(lockDir, { recursive: true, force: true });
      continue;
    }
    const owner: LockOwner = {
      pid: process.pid,
      at: new Date(now).toISOString(),
      host: hostname(),
    };
    writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify(owner)}\n`);
    let released = false;
    return {
      acquired: true,
      release: () => {
        if (released) return;
        released = true;
        rmSync(lockDir, { recursive: true, force: true });
      },
    };
  }
  return { acquired: false, owner: inspectLock(coordRoot, cfg, now).owner };
}
