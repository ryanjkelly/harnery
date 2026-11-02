import { spawnSync } from "node:child_process";
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
  if (rel === null) return { scope: resolve(scope), entries: null };
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
    return { scope: resolve(scope), entries: null };
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
  return { scope: resolve(scope), entries };
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
