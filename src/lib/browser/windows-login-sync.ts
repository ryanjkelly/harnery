import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Cookie } from "../cookies/client.ts";
import { CookieJar, mergeCookies } from "../cookies/index.ts";
import type { WindowsChromeHarvest } from "./windows-chrome.ts";

/**
 * Keep the shared cookie store current with the WSL sign-in profile.
 *
 * Under WSL, `browse --login` signs in through the Windows host's Chrome on a
 * dedicated profile and copies that site's cookies into the cookie store when
 * the window closes. People also keep that profile open as an ordinary
 * browser and sign in to other sites there later. Nothing copies those
 * sign-ins when the window is closed outside a waiting `--login` run, so a
 * later headless run would show the site signed out.
 *
 * Before a headless run, this module compares the profile's cookie database
 * modification time with the time recorded at the last copy for the run's
 * domain. When the profile changed and no Chrome is running on it, the
 * domain's cookies are read (the same headless read `--login` uses) and
 * merged into the store. A profile that is open is never touched. A small
 * owner-only state file next to the store records, per domain, the database
 * time and a fingerprint of the cookies last read. When a read returns the
 * same cookies as last time, nothing is merged, so cookies a headless run
 * refreshed in the store are not replaced with the profile's older copies.
 */

export interface DomainSyncRecord {
  /** When the profile's cookies for the domain were last read. */
  syncedAt: string;
  /** Cookie database modification time right after that read. */
  cookieDbMtimeMs: number;
  /** SHA-256 over the cookies read, so an unchanged read merges nothing. */
  fingerprint: string;
  /** Number of cookies read. */
  cookies: number;
}

export interface LoginSyncState {
  version: 1;
  domains: Record<string, DomainSyncRecord>;
}

/** The sync-state file for a cookie store: `<store>.login-sync.json`, beside it. */
export function loginSyncStatePath(storePath: string): string {
  const name = basename(storePath).replace(/\.json$/i, "");
  return join(dirname(storePath), `${name}.login-sync.json`);
}

export function readLoginSyncState(statePath: string): LoginSyncState {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<LoginSyncState>;
    if (parsed && parsed.version === 1 && parsed.domains && typeof parsed.domains === "object") {
      return { version: 1, domains: parsed.domains };
    }
  } catch {
    // Missing or unreadable state means nothing has been copied yet.
  }
  return { version: 1, domains: {} };
}

/** Write the state file owner-only, replacing it atomically. */
export function writeLoginSyncState(statePath: string, state: LoginSyncState): void {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, statePath);
}

/** Order-independent fingerprint of a cookie set. Values are hashed, never stored. */
export function cookieFingerprint(cookies: Cookie[]): string {
  const rows = cookies
    .map((c) => JSON.stringify([c.name, c.domain, c.path, c.value, c.expires]))
    .sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

export type LoginSyncDecision =
  /** No cookie database: the profile has never been used. */
  | "no-profile"
  /** The database has not changed since the last read for this domain. */
  | "current"
  /** The database is newer, but Chrome is open on the profile. */
  | "open"
  /** The database is newer (or the read is forced) and the profile is closed. */
  | "sync";

/**
 * Decide what to do before reading. `running` is consulted only when the
 * database is newer, since checking for Chrome costs a PowerShell call.
 */
export function decideLoginSync(input: {
  cookieDbMtimeMs: number | undefined;
  record: DomainSyncRecord | undefined;
  running: () => boolean;
  force?: boolean;
}): LoginSyncDecision {
  if (input.cookieDbMtimeMs === undefined) return "no-profile";
  if (!input.force && input.record && input.cookieDbMtimeMs <= input.record.cookieDbMtimeMs)
    return "current";
  return input.running() ? "open" : "sync";
}

export interface LoginSyncDeps {
  /** Newest modification time of the profile's cookie database, or `undefined`. */
  cookieDbMtimeMs: () => number | undefined;
  /** Ids of Chrome processes running on the profile. */
  profileProcesses: () => number[];
  /** Read the profile's cookies for `domain`; the profile must be closed. */
  harvest: (domain: string) => WindowsChromeHarvest;
  now?: () => Date;
}

export interface LoginSyncResult {
  status: "no-profile" | "current" | "open" | "busy" | "synced" | "unchanged";
  domain: string;
  /** Cookies read from the profile (0 when nothing was read). */
  cookies: number;
  /** Cookies merged into the store (0 unless `synced`). */
  merged: number;
  sessionCookies: number;
  /** Cookie names merged, sorted. Never values. */
  names: string[];
  /** Chrome process ids on the profile when `open`. */
  processes: number[];
}

/**
 * Copy the profile's cookies for `domain` into the store when the profile
 * changed since the last copy and is closed. `force` skips the time check
 * and merges whatever is read. Throws only on read failures; the caller
 * decides whether that is a warning.
 */
export function syncLoginCookies(input: {
  domain: string;
  storePath: string;
  deps: LoginSyncDeps;
  force?: boolean;
}): LoginSyncResult {
  const { domain, storePath, deps } = input;
  const base: LoginSyncResult = {
    status: "current",
    domain,
    cookies: 0,
    merged: 0,
    sessionCookies: 0,
    names: [],
    processes: [],
  };
  const statePath = loginSyncStatePath(storePath);
  const state = readLoginSyncState(statePath);
  const record = state.domains[domain];
  let processes: number[] = [];
  const decision = decideLoginSync({
    cookieDbMtimeMs: deps.cookieDbMtimeMs(),
    record,
    force: input.force,
    running: () => {
      processes = deps.profileProcesses();
      return processes.length > 0;
    },
  });
  if (decision === "no-profile") return { ...base, status: "no-profile" };
  if (decision === "current") return base;
  if (decision === "open") return { ...base, status: "open", processes };

  const release = acquireSyncLock(statePath);
  if (!release) return { ...base, status: "busy" };
  try {
    const { cookies } = deps.harvest(domain);
    const fingerprint = cookieFingerprint(cookies);
    const changed = input.force || !record || record.fingerprint !== fingerprint;
    let merged: Cookie[] = [];
    if (changed && cookies.length > 0) {
      const jar = new CookieJar({ path: storePath, source: "harn-browse" });
      jar.save(mergeCookies(jar.load(), cookies));
      merged = cookies;
    }
    const after = readLoginSyncState(statePath);
    after.domains[domain] = {
      syncedAt: (deps.now?.() ?? new Date()).toISOString(),
      cookieDbMtimeMs: deps.cookieDbMtimeMs() ?? 0,
      fingerprint,
      cookies: cookies.length,
    };
    writeLoginSyncState(statePath, after);
    return {
      ...base,
      status: merged.length > 0 ? "synced" : "unchanged",
      cookies: cookies.length,
      merged: merged.length,
      sessionCookies: merged.filter((c) => c.expires <= 0).length,
      names: [...new Set(merged.map((c) => c.name))].sort(),
    };
  } finally {
    release();
  }
}

/**
 * Record a read that happened elsewhere (the `--login` flow), so the next
 * headless run does not read the same cookies again.
 */
export function recordLoginSync(input: {
  domain: string;
  storePath: string;
  cookies: Cookie[];
  cookieDbMtimeMs: number | undefined;
  now?: Date;
}): void {
  const statePath = loginSyncStatePath(input.storePath);
  const state = readLoginSyncState(statePath);
  state.domains[input.domain] = {
    syncedAt: (input.now ?? new Date()).toISOString(),
    cookieDbMtimeMs: input.cookieDbMtimeMs ?? 0,
    fingerprint: cookieFingerprint(input.cookies),
    cookies: input.cookies.length,
  };
  writeLoginSyncState(statePath, state);
}

/** Newest mtime among a profile's cookie database locations, or `undefined`. */
export function profileCookieDbMtimeMs(
  profileLinux: string,
  stat: (path: string) => number | undefined = fileMtimeMs,
): number | undefined {
  const times = [
    join(profileLinux, "Default", "Network", "Cookies"),
    join(profileLinux, "Default", "Cookies"),
  ]
    .map((path) => stat(path))
    .filter((t): t is number => t !== undefined);
  return times.length > 0 ? Math.max(...times) : undefined;
}

function fileMtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

const LOCK_STALE_MS = 3 * 60_000;

/**
 * One read at a time: a second headless Chrome on the profile would refuse
 * to start. A lock older than three minutes is treated as abandoned.
 */
function acquireSyncLock(statePath: string): (() => void) | null {
  const lockPath = `${statePath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lockPath, "wx", 0o600));
      return () => rmSync(lockPath, { force: true });
    } catch {
      const age = existsSync(lockPath) ? Date.now() - (fileMtimeMs(lockPath) ?? 0) : 0;
      if (age < LOCK_STALE_MS) return null;
      rmSync(lockPath, { force: true });
    }
  }
  return null;
}
