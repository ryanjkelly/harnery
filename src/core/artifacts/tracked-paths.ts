import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * What Git tracks under one directory, read with a single `git ls-files`.
 *
 * A sweep used to start one Git process per artifact, which costs seconds
 * each on a slow host and held the store lock for a minute. One listing per
 * pass answers every membership question in memory. `entries` holds each
 * tracked path and every ancestor directory; `null` means Git could not
 * answer, and every lookup then fails closed.
 */
export interface TrackedPathSnapshot {
  readonly scope: string;
  readonly entries: ReadonlySet<string> | null;
  /**
   * The Git index file as it stood just before the listing ran, or `null`
   * when it could not be identified. The store lock does not serialize Git
   * staging, so a deletion compares this first and lists again on any change.
   */
  readonly index: string | null;
}

const indexPaths = new Map<string, string | null>();

/** Where Git keeps this checkout's index, asked once per process and checkout. */
function gitIndexPath(repoRoot: string): string | null {
  const root = resolve(repoRoot);
  const key = JSON.stringify([root, process.env.GIT_DIR ?? "", process.env.GIT_INDEX_FILE ?? ""]);
  if (indexPaths.has(key)) return indexPaths.get(key)!;
  const result = spawnSync("git", ["rev-parse", "--git-path", "index"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  const path =
    result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()
      ? resolve(root, result.stdout.trim())
      : null;
  // A failed lookup is not cached, so a later call can still find the index.
  if (path !== null) indexPaths.set(key, path);
  return path;
}

/** Inode, size, and times of the index; Git replaces the file on every write. */
function indexIdentity(repoRoot: string): string | null {
  const path = gitIndexPath(repoRoot);
  if (path === null) return null;
  try {
    const st = statSync(path);
    return [st.ino, st.size, st.mtimeMs, st.ctimeMs].join(":");
  } catch (error) {
    // A repository with nothing staged yet has no index file at all.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : null;
  }
}

/** Windows and macOS default to case-insensitive file systems. */
const CASE_INSENSITIVE_PATHS = process.platform === "win32" || process.platform === "darwin";

function trackedKey(rel: string): string {
  const key = rel.split(sep).join("/");
  return CASE_INSENSITIVE_PATHS ? key.toLowerCase() : key;
}

function relativeInside(repoRoot: string, path: string): string | null {
  const rel = relative(resolve(repoRoot), resolve(path));
  return rel.startsWith("..") || isAbsolute(rel) ? null : rel;
}

/** One `git ls-files` for everything under `scope` (a repository-local path). */
export function readTrackedPaths(repoRoot: string, scope: string): TrackedPathSnapshot {
  const rel = relativeInside(repoRoot, scope);
  if (rel === null) return { scope: resolve(scope), entries: null, index: null };
  // Identify the index before listing, so a write during the listing counts as a change.
  const index = indexIdentity(repoRoot);
  const pathspec = rel.split(sep).join("/") || ".";
  // windowsHide: this runs inside the console-less session-maintenance worker,
  // where an unhidden console child opens a new terminal window on Windows.
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--", CASE_INSENSITIVE_PATHS ? `:(icase)${pathspec}` : pathspec],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 },
  );
  // If Git itself cannot answer, fail closed.
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return { scope: resolve(scope), entries: null, index };
  }
  const entries = new Set<string>();
  for (const file of result.stdout.split("\0")) {
    if (!file) continue;
    let key = trackedKey(file);
    while (key && !entries.has(key)) {
      entries.add(key);
      const slash = key.lastIndexOf("/");
      key = slash === -1 ? "" : key.slice(0, slash);
    }
  }
  return { scope: resolve(scope), entries, index };
}

/**
 * The same snapshot while the Git index is unchanged since it was listed;
 * otherwise a new listing. An index that cannot be identified counts as
 * changed, and a failed listing fails closed like any other.
 */
export function refreshTrackedPaths(
  repoRoot: string,
  snapshot: TrackedPathSnapshot,
): TrackedPathSnapshot {
  if (snapshot.index !== null && indexIdentity(repoRoot) === snapshot.index) return snapshot;
  return readTrackedPaths(repoRoot, snapshot.scope);
}

export function containsTrackedPath(
  repoRoot: string,
  path: string,
  snapshot?: TrackedPathSnapshot,
): boolean {
  const rel = relativeInside(repoRoot, path);
  if (rel === null) return true;
  const resolved = resolve(path);
  // A snapshot answers only for paths it covered; anything else gets its own read.
  const covered =
    snapshot &&
    (resolved === snapshot.scope || resolved.startsWith(`${snapshot.scope}${sep}`)) &&
    snapshot;
  const source = covered || readTrackedPaths(repoRoot, path);
  if (source.entries === null) return true;
  return rel === "" ? source.entries.size > 0 : source.entries.has(trackedKey(rel));
}
