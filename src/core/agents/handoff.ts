/**
 * Named handoff of claimed, dirty paths between live sessions (ADR 0263).
 *
 * A session that edited a shared file can offer the file's remaining work to
 * a named live peer. Nothing moves until that peer accepts. On acceptance the
 * path leaves the sender's dirty-file obligation and joins the receiver's;
 * the sender still has to push its own commits.
 *
 * This module holds the read-side helpers: a privacy-safe Git summary of one
 * path, live peer lookup by name, and the best-effort explanation printed when
 * a path is dirty only from lines another session wrote.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { HandoffGitStateV3 } from "../events/v3/contract.ts";
import type { CoordinationViewV3 } from "../events/v3/coordination-view.ts";
import { liveInstanceIdV3 } from "../events/v3/live-routing.ts";
import { type HandoffProjectionV3, reduceSafetyProjectionV3 } from "../events/v3/projection.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";

/** Handoff ids satisfy the V3 safe-token pattern (no underscore). */
export function newHandoffId(): string {
  return `hof-${randomUUID()}`;
}

interface PeerRow {
  instance_id: string;
  name?: string;
  files_touched?: string[];
  last_heartbeat?: string;
}

/** True when two instance ids name the same V3 instance, native or canonical. */
export function sameInstance(left: string, right: string): boolean {
  return left === right || liveInstanceIdV3(left) === liveInstanceIdV3(right);
}

/** Strip an `agent-` display prefix so `--to agent-Ada` and `--to Ada` agree. */
export function normalizePeerName(name: string): string {
  return name.trim().replace(/^agent-/i, "");
}

export type LivePeerLookup<T extends PeerRow> =
  | { state: "found"; peer: T }
  | { state: "self" }
  | { state: "not_live" }
  | { state: "ambiguous"; count: number };

/**
 * Find one live peer by display name. `freshnessSeconds` bounds how recently
 * the peer must have been observed; a session past it is not live for a
 * handoff, because nobody would be there to accept and finish the file.
 */
export function findLivePeerByName<T extends PeerRow>(
  rows: readonly T[],
  name: string,
  selfInstanceId: string,
  freshnessSeconds: number,
  nowMs = Date.now(),
): LivePeerLookup<T> {
  const wanted = normalizePeerName(name).toLowerCase();
  if (wanted.length === 0) return { state: "not_live" };
  const named = rows.filter((row) => (row.name ?? "").toLowerCase() === wanted);
  const fresh = named.filter((row) => {
    const ts = Date.parse(row.last_heartbeat ?? "");
    return Number.isFinite(ts) && nowMs - ts <= freshnessSeconds * 1000;
  });
  const others = fresh.filter((row) => !sameInstance(row.instance_id, selfInstanceId));
  if (others.length === 1) return { state: "found", peer: others[0]! };
  if (others.length > 1) return { state: "ambiguous", count: others.length };
  if (fresh.length > 0) return { state: "self" };
  return { state: "not_live" };
}

function git(args: string[], cwd: string): { status: number; stdout: string } {
  const env = { ...process.env };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_PREFIX",
  ] as const) {
    delete env[name];
  }
  const result = spawnSync("git", args, {
    windowsHide: true,
    cwd,
    env,
    encoding: "utf8",
    timeout: 5_000,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

/** Nearest existing directory at or above the path, inside the coord root. */
function probeDirectory(coordRoot: string, absolutePath: string): string | null {
  let current = absolutePath;
  if (existsSync(current) && !statSync(current).isDirectory()) current = dirname(current);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  const rel = relative(coordRoot, current);
  return rel.startsWith("..") || isAbsolute(rel) ? null : current;
}

/**
 * Summarize one path's Git state without reading its contents: the HEAD of
 * the repository that contains it and whether the path is clean, staged,
 * unstaged, both, untracked, or missing.
 */
export function handoffGitState(coordRoot: string, path: string): HandoffGitStateV3 {
  const absolutePath = isAbsolute(path) ? path : join(coordRoot, path);
  const probe = probeDirectory(coordRoot, absolutePath);
  if (!probe) return { worktree: "unknown" };
  const top = git(["rev-parse", "--show-toplevel"], probe);
  if (top.status !== 0) return { worktree: "unknown" };
  const repoRoot = top.stdout.trim();
  const head = git(["rev-parse", "HEAD"], probe);
  const headSha = head.status === 0 ? head.stdout.trim() : "";
  const withHead = (worktree: HandoffGitStateV3["worktree"]): HandoffGitStateV3 =>
    /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headSha) ? { head: headSha, worktree } : { worktree };
  // Run from the probe directory with a path relative to it, so a symlinked
  // coord root (macOS /var) still matches Git's resolved top level.
  const pathspec = relative(probe, absolutePath).replaceAll("\\", "/") || ".";
  const status = git(["status", "--porcelain=v1", "--untracked-files=all", "--", pathspec], probe);
  if (repoRoot.length === 0 || status.status !== 0) return withHead("unknown");
  const lines = status.stdout.split("\n").filter((line) => line.length >= 2);
  if (lines.length === 0) return withHead(existsSync(absolutePath) ? "clean" : "missing");
  if (lines.every((line) => line.startsWith("??"))) return withHead("untracked");
  const staged = lines.some((line) => line[0] !== " " && line[0] !== "?");
  const unstaged = lines.some((line) => line[1] !== " " && line[0] !== "?");
  if (staged && unstaged) return withHead("staged_and_unstaged");
  return withHead(staged ? "staged" : "unstaged");
}

/** A path whose Git state needs no commit: a clean file, or one already gone from Git. */
export function handoffPathIsClean(state: HandoffGitStateV3): boolean {
  return state.worktree === "clean" || state.worktree === "missing";
}

/** Open offers addressed to this session. */
export function pendingHandoffsFor(
  view: Pick<CoordinationViewV3, "handoffs">,
  receiverInstanceId: string,
): HandoffProjectionV3[] {
  const receiver = liveInstanceIdV3(receiverInstanceId);
  return Object.values(view.handoffs ?? {})
    .filter((handoff) => handoff.state === "offered" && handoff.receiver_instance_id === receiver)
    .sort((left, right) => left.offered_at.localeCompare(right.offered_at));
}

/** Open offers this session made that the receiver has not accepted yet. */
export function outgoingHandoffsFrom(
  view: Pick<CoordinationViewV3, "handoffs">,
  senderInstanceId: string,
): HandoffProjectionV3[] {
  const sender = liveInstanceIdV3(senderInstanceId);
  return Object.values(view.handoffs ?? {})
    .filter((handoff) => handoff.state === "offered" && handoff.sender_instance_id === sender)
    .sort((left, right) => left.offered_at.localeCompare(right.offered_at));
}

export interface DirtyPathPeers {
  path: string;
  /** Display names (or short ids) of live peers that hold the same path now. */
  holders: string[];
  /**
   * Best effort: a commit to this path landed after this session claimed it,
   * so the session's own edits are probably committed and the remaining
   * changes are another session's.
   */
  own_edits_committed: boolean;
}

/**
 * Explain dirty paths that other live sessions also hold. This is a
 * best-effort reading, not hunk ownership: Harnery records which session
 * claimed a path and when, and Git records when the path was last committed.
 */
export function describeDirtyPathPeers(
  coordRoot: string,
  selfInstanceId: string,
  dirtyPaths: readonly string[],
  rows: readonly PeerRow[],
): DirtyPathPeers[] {
  if (dirtyPaths.length === 0) return [];
  const peers = rows.filter((row) => !sameInstance(row.instance_id, selfInstanceId));
  const shared = dirtyPaths.filter((path) =>
    peers.some((row) => (row.files_touched ?? []).includes(path)),
  );
  if (shared.length === 0) return [];
  const acquiredAt = ownClaimTimes(coordRoot, selfInstanceId);
  return shared.map((path) => {
    const holders = peers
      .filter((row) => (row.files_touched ?? []).includes(path))
      .map((row) => (row.name ? row.name : row.instance_id.slice(0, 8)));
    const claimedAt = acquiredAt.get(path);
    const committedAt = lastCommitTime(coordRoot, path);
    return {
      path,
      holders: [...new Set(holders)].sort(),
      own_edits_committed:
        claimedAt !== undefined && committedAt !== undefined && committedAt >= claimedAt,
    };
  });
}

function ownClaimTimes(coordRoot: string, selfInstanceId: string): Map<string, number> {
  const times = new Map<string, number>();
  try {
    const read = readLedgerV3(coordRoot);
    const observed = new Map<string, string>();
    for (const { event } of read.events) observed.set(event.event_id, event.time.observed_at);
    const self = liveInstanceIdV3(selfInstanceId);
    for (const held of Object.values(reduceSafetyProjectionV3(read).claims)) {
      if (held.subject_instance_id !== self || held.target_display === undefined) continue;
      const at = Date.parse(observed.get(held.acquired_event_id) ?? "");
      // Git commit times have one-second precision; compare at that grain.
      if (Number.isFinite(at)) times.set(held.target_display, Math.floor(at / 1000) * 1000);
    }
  } catch {
    // Best effort: without claim times the explanation stays conservative.
  }
  return times;
}

function lastCommitTime(coordRoot: string, path: string): number | undefined {
  const absolutePath = join(coordRoot, path);
  const cwd = dirname(absolutePath);
  if (!existsSync(cwd)) return undefined;
  const result = git(["log", "-1", "--format=%ct", "--", basename(absolutePath)], cwd);
  const seconds = Number.parseInt(result.stdout.trim(), 10);
  return result.status === 0 && Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * One plain sentence per shared dirty path, followed by the exact handoff
 * command. Empty when no live peer holds any of the paths.
 */
export function formatDirtyPathPeers(peers: readonly DirtyPathPeers[], bin: string): string[] {
  const lines: string[] = [];
  for (const entry of peers) {
    const names = entry.holders.map((name) => `agent-${name}`).join(", ");
    const to = entry.holders[0]!;
    lines.push(
      entry.own_edits_committed
        ? `${entry.path} is dirty only from changes this session did not write: your edits to it were committed after you claimed it, and ${names} also hold it.`
        : `${entry.path} is also held by ${names}; if its remaining changes are theirs, hand it over instead of committing them.`,
      `  Hand it over: \`${bin} agents handoff ${entry.path} --to ${to}\`, then they run \`${bin} agents handoff accept ${entry.path}\`.`,
    );
  }
  return lines;
}
