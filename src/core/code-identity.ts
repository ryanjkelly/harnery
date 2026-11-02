/**
 * Cheap identity of the installed Harnery code, for long-lived daemons.
 *
 * A detached daemon keeps running the modules it loaded at start. When the
 * package is upgraded or its checkout moves to a new commit, nothing in the
 * process notices, so a fixed bug keeps happening until someone kills it by
 * hand. Each daemon records this identity when it starts and compares it on
 * its own loop; a confirmed change makes it exit (and, where the daemon has
 * no other restart path, relaunch itself) so the new code takes over.
 *
 * The identity is the package version plus, when the package root is a Git
 * checkout (a `.git` directory, or a submodule or worktree `.git` file), the
 * resolved HEAD commit. It is read with plain file reads, never a `git`
 * subprocess, and cached against the stat of every file consulted, so a
 * daemon can afford to ask on every tick. An unreadable identity is `null`,
 * and `null` never counts as a change: a daemon that cannot tell must not
 * restart in a loop.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivateJsonAtomic } from "./storage/atomic-json.ts";

/** The package root this module was loaded from (`src/` or `dist/` sit one level below it). */
export function harneryCodeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** What a daemon stores in its pid or status record. */
export interface CodeIdentityRecord {
  /** `<version>` or `<version>@<commit>`; `null` when it could not be read. */
  id: string | null;
  /** The package root the identity describes. */
  root: string;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_SMALL_FILE_BYTES = 64 * 1024;
const MAX_PACKED_REFS_BYTES = 8 * 1024 * 1024;

interface ReadTrace {
  /** Every path consulted, in order, including ones that did not exist. */
  paths: string[];
}

function readSmall(path: string, trace: ReadTrace, maxBytes = MAX_SMALL_FILE_BYTES): string | null {
  trace.paths.push(path);
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function packageVersion(root: string, trace: ReadTrace): string | null {
  const body = readSmall(resolve(root, "package.json"), trace, 1024 * 1024);
  if (body === null) return null;
  try {
    const version = (JSON.parse(body) as { version?: unknown }).version;
    return typeof version === "string" && /^[0-9A-Za-z._+-]{1,100}$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * The checkout's Git directory: `.git` itself, or the target a `.git` file
 * names (`gitdir: <path>`, relative to the root), as submodules and linked
 * worktrees use. `undefined` means the root is not a checkout; `null` means
 * it is one but could not be resolved.
 */
function gitDir(root: string, trace: ReadTrace): string | null | undefined {
  const dotGit = resolve(root, ".git");
  trace.paths.push(dotGit);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(dotGit).isDirectory();
  } catch {
    return undefined;
  }
  if (isDirectory) return dotGit;
  const body = readSmall(dotGit, trace);
  const match = body?.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match?.[1]) return null;
  return isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
}

/** Refs live in the common directory for linked worktrees; HEAD stays per worktree. */
function commonDir(dir: string, trace: ReadTrace): string {
  const body = readSmall(resolve(dir, "commondir"), trace)?.trim();
  if (!body) return dir;
  return isAbsolute(body) ? body : resolve(dir, body);
}

function resolveRef(dir: string, common: string, ref: string, trace: ReadTrace): string | null {
  if (!/^refs\/[^\0\s]+$/.test(ref) || ref.split("/").includes("..")) return null;
  for (const base of dir === common ? [dir] : [dir, common]) {
    const loose = readSmall(resolve(base, ref), trace)?.trim();
    if (loose && COMMIT_PATTERN.test(loose)) return loose;
  }
  const packed = readSmall(resolve(common, "packed-refs"), trace, MAX_PACKED_REFS_BYTES);
  if (packed === null) return null;
  for (const line of packed.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const commit = line.slice(0, space);
    if (line.slice(space + 1).trim() === ref && COMMIT_PATTERN.test(commit)) return commit;
  }
  return null;
}

function headCommit(dir: string, trace: ReadTrace): string | null {
  const head = readSmall(resolve(dir, "HEAD"), trace)?.trim();
  if (!head) return null;
  if (COMMIT_PATTERN.test(head)) return head;
  const symbolic = head.match(/^ref:\s*(\S+)$/);
  if (!symbolic?.[1]) return null;
  return resolveRef(dir, commonDir(dir, trace), symbolic[1], trace);
}

function computeIdentity(root: string, trace: ReadTrace): string | null {
  const version = packageVersion(root, trace);
  if (version === null) return null;
  const dir = gitDir(root, trace);
  if (dir === undefined) return version;
  if (dir === null) return null;
  const commit = headCommit(dir, trace);
  return commit === null ? null : `${version}@${commit}`;
}

/** Read the identity of the code at `root` with no caching. */
export function readCodeIdentity(root: string = harneryCodeRoot()): string | null {
  return computeIdentity(root, { paths: [] });
}

function statSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * A reader that recomputes only when one of the files it consulted last time
 * changed (or appeared, or vanished). Each call costs a few `stat`s.
 */
export function createCodeIdentityReader(
  root: string = harneryCodeRoot(),
  options: { compute?: (root: string) => { id: string | null; paths: string[] } } = {},
): () => string | null {
  const compute =
    options.compute ??
    ((codeRoot: string) => {
      const trace: ReadTrace = { paths: [] };
      return { id: computeIdentity(codeRoot, trace), paths: trace.paths };
    });
  let cached: { id: string | null; signatures: Array<[string, string]> } | undefined;
  return () => {
    if (cached?.signatures.every(([path, signature]) => statSignature(path) === signature)) {
      return cached.id;
    }
    // Take the signatures between two reads and cache only when both reads
    // agree: a write that lands after the signatures were taken then shows up
    // as a signature mismatch on the next call instead of hiding forever.
    const first = compute(root);
    const signatures = [...new Set(first.paths)].map((path): [string, string] => [
      path,
      statSignature(path),
    ]);
    const second = compute(root);
    const samePaths =
      second.paths.length === first.paths.length &&
      second.paths.every((path, index) => path === first.paths[index]);
    cached = second.id === first.id && samePaths ? { id: second.id, signatures } : undefined;
    return second.id;
  };
}

let sharedReader: (() => string | null) | undefined;

/** The identity of the code running this process, cached by file stat. */
export function currentCodeIdentity(): CodeIdentityRecord {
  sharedReader ??= createCodeIdentityReader();
  return { id: sharedReader(), root: harneryCodeRoot() };
}

/** `0.42.0@1a2b3c4d5e6f` for logs; the version alone when there is no commit. */
export function shortCodeIdentity(id: string | null | undefined): string {
  if (!id) return "unknown";
  const at = id.lastIndexOf("@");
  return at < 0 ? id : `${id.slice(0, at)}@${id.slice(at + 1, at + 13)}`;
}

/**
 * Should a launcher replace a live daemon whose record carries `recorded`?
 *
 * - The current identity is unknown: no (never restart on a guess).
 * - The record has no identity at all: yes, once. The daemon predates
 *   identity recording, so it cannot be shown to run the current code; its
 *   replacement records one.
 * - The record names another package root: no. A second installation calling
 *   the launcher must not take turns replacing the first one's daemon.
 * - The recorded identity is unknown, or equal: no.
 * - Otherwise it differs: yes.
 */
export function codeIdentityReplacementNeeded(
  recorded: unknown,
  current: CodeIdentityRecord,
): boolean {
  if (current.id === null) return false;
  if (recorded === undefined) return true;
  if (!recorded || typeof recorded !== "object") return false;
  const record = recorded as Partial<CodeIdentityRecord>;
  if (typeof record.root !== "string" || resolve(record.root) !== resolve(current.root)) {
    return false;
  }
  return typeof record.id === "string" && record.id !== current.id;
}

export interface CodeIdentityChange {
  from: string;
  to: string;
}

export interface CodeChangeWatch {
  /** The identity captured when the watch was created (the daemon's start). */
  readonly initial: CodeIdentityRecord;
  /**
   * The confirmed change, or `null`. Reads at most once per interval, and
   * reports a change only after two consecutive reads agree on the same new
   * identity, so a daemon does not relaunch onto a half-finished update.
   * Once confirmed the change is sticky.
   */
  poll(): CodeIdentityChange | null;
  /**
   * A fresh, unconfirmed read: the change since start, or `null` when the
   * code is the same or either identity is unknown. For a daemon that was
   * stopped from outside and must decide whether to relaunch.
   */
  checkNow(): CodeIdentityChange | null;
}

export const CODE_CHANGE_CHECK_INTERVAL_MS = 30_000;

export function watchCodeIdentity(
  options: { read?: () => CodeIdentityRecord; intervalMs?: number; now?: () => number } = {},
): CodeChangeWatch {
  const read = options.read ?? currentCodeIdentity;
  const intervalMs = Math.max(0, options.intervalMs ?? CODE_CHANGE_CHECK_INTERVAL_MS);
  const now = options.now ?? Date.now;
  const initial = read();
  let lastCheck = now();
  let pending: string | undefined;
  let confirmed: CodeIdentityChange | null = null;
  return {
    initial,
    poll() {
      if (confirmed) return confirmed;
      if (initial.id === null) return null;
      const at = now();
      if (at - lastCheck < intervalMs) return null;
      lastCheck = at;
      let id: string | null;
      try {
        id = read().id;
      } catch {
        id = null;
      }
      if (id === null || id === initial.id) {
        pending = undefined;
        return null;
      }
      if (pending !== id) {
        pending = id;
        return null;
      }
      confirmed = { from: initial.id, to: id };
      return confirmed;
    },
    checkNow() {
      if (confirmed) return confirmed;
      if (initial.id === null) return null;
      let id: string | null;
      try {
        id = read().id;
      } catch {
        return null;
      }
      return id === null || id === initial.id ? null : { from: initial.id, to: id };
    },
  };
}

/** One lifecycle line every daemon writes on a confirmed change. */
export function codeChangeMessage(change: CodeIdentityChange): string {
  return `code changed (${shortCodeIdentity(change.from)} -> ${shortCodeIdentity(change.to)}); exiting for restart`;
}

/*
 * Replacement requests. A launcher that finds a live daemon on older code
 * asks it to hand over through a file of its own, never through the
 * operator's stop request (which may mean "paused") and never through a
 * signal (which on Windows terminates the process outright). The request
 * names the daemon generation it targets, so a successor ignores it.
 */

interface ReplacementRequestFile {
  schema_version: 1;
  target_nonce: string;
  request_id: string;
  requested_at: string;
  requested_by_pid: number;
}

/** Ask the daemon whose record carries `targetNonce` to finish its current work and hand over. */
export function writeReplacementRequest(path: string, targetNonce: string): string {
  const request: ReplacementRequestFile = {
    schema_version: 1,
    target_nonce: targetNonce,
    request_id: randomUUID(),
    requested_at: new Date().toISOString(),
    requested_by_pid: process.pid,
  };
  writePrivateJsonAtomic(path, request);
  return request.request_id;
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Is there a replacement request addressed to the daemon generation `nonce`? */
export function replacementRequestedFor(path: string, nonce: string): boolean {
  return readJsonObject(path)?.target_nonce === nonce;
}

/** Remove a replacement request unless it targets `keepNonce` (a successor's own). */
export function clearReplacementRequest(path: string, keepNonce?: string): void {
  if (keepNonce !== undefined && replacementRequestedFor(path, keepNonce)) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // A request left behind targets a generation that no longer exists.
  }
}

/**
 * Daemons from before replacement requests understand only the durable stop
 * request. The launcher writes one carrying its own `replacement_id`, so it
 * can later tell its request from an operator's stop written over it.
 */
export function writeStopForReplacement(path: string): string {
  const replacementId = randomUUID();
  writePrivateJsonAtomic(path, {
    requested_at: new Date().toISOString(),
    requested_by_pid: process.pid,
    replacement_id: replacementId,
  });
  return replacementId;
}

/**
 * Withdraw the launcher's own stop request. `operator` means someone wrote a
 * stop over it, which must be honored; `missing` means it is already gone.
 */
export function withdrawStopForReplacement(
  path: string,
  replacementId: string,
): "withdrawn" | "operator" | "missing" {
  const value = readJsonObject(path);
  if (value === null) {
    try {
      statSync(path);
      return "operator";
    } catch {
      return "missing";
    }
  }
  if (value.replacement_id !== replacementId) return "operator";
  rmSync(path, { force: true });
  return "withdrawn";
}
