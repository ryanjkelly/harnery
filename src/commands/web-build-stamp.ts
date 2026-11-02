import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Production-build freshness for `harn web up --prod` and `harn web start`.
 *
 * The dashboard bundles `web/` plus harnery's own `src/` (through `../../src`
 * imports). A `.next/` left over from before an update keeps serving the old
 * pages, so a page added by the update returns 404 until someone rebuilds.
 * After every successful build Harnery writes a stamp into the build directory
 * recording a fingerprint of those sources. A production start compares the
 * stamp with the current fingerprint and rebuilds when they differ.
 *
 * The fingerprint prefers Git: the tree hashes of `web/` and `src/` at HEAD
 * plus the content of every uncommitted or untracked file under them. Outside
 * a Git checkout it falls back to the newest modification time and file count
 * over the dashboard's inputs. Neither path reads `node_modules/`.
 */

export const WEB_BUILD_STAMP_FILE = "harnery-build-stamp.json";
const STAMP_VERSION = 1;
const GIT_TIMEOUT_MS = 15_000;

/** Files and directories under `web/` whose changes alter the production bundle. */
const WEB_MTIME_INPUTS = [
  "app",
  "components",
  "lib",
  "middleware.ts",
  "next.config.ts",
  "package.json",
];

export interface WebSourceFingerprint {
  kind: "git" | "mtime";
  value: string;
}

export interface WebBuildStamp {
  version: number;
  fingerprint: WebSourceFingerprint;
  built_at: string;
}

export type WebBuildFreshness =
  | { stale: false }
  | { stale: true; reason: "missing" | "unstamped" | "changed"; message: string };

type GitRunner = (args: string[], cwd: string) => { status: number | null; stdout: string };

const defaultGit: GitRunner = (args, cwd) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
};

/** The build directory Next writes to, honoring the dashboard's distDir override. */
export function webDistDir(
  webDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return path.resolve(webDir, env.HARNERY_WEB_DIST_DIR || ".next");
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Split `git status --porcelain=v1 -z` output into repository-relative paths.
 * A rename or copy entry carries its source path as the following record.
 */
export function parsePorcelainZ(output: string): Array<{ status: string; path: string }> {
  const records = output.split("\0");
  const entries: Array<{ status: string; path: string }> = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? "";
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    entries.push({ status, path: record.slice(3) });
    if (status.includes("R") || status.includes("C")) i++;
  }
  return entries;
}

function gitFingerprint(packageRoot: string, git: GitRunner): WebSourceFingerprint | null {
  const revs = git(["rev-parse", "--show-toplevel", "HEAD:./web", "HEAD:./src"], packageRoot);
  if (revs.status !== 0) return null;
  const [topLevel, webTree, srcTree] = revs.stdout.trim().split(/\r?\n/);
  if (!topLevel || !webTree || !srcTree) return null;

  const status = git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "web", "src"],
    packageRoot,
  );
  if (status.status !== 0) return null;

  const dirty = parsePorcelainZ(status.stdout)
    .map((entry) => {
      const file = path.resolve(topLevel, entry.path);
      let content = "missing";
      try {
        const info = statSync(file);
        content = info.isFile() ? sha256(readFileSync(file)) : `non-file:${info.mtimeMs}`;
      } catch {
        // Deleted in the working tree; the status code already records it.
      }
      return `${entry.status} ${entry.path} ${content}`;
    })
    .sort();
  const dirtyPart = dirty.length === 0 ? "clean" : sha256(dirty.join("\n"));
  return { kind: "git", value: `${webTree}:${srcTree}:${dirtyPart}` };
}

interface MtimeAccumulator {
  newest: number;
  files: number;
}

function walkMtimes(target: string, acc: MtimeAccumulator): void {
  let info: ReturnType<typeof statSync>;
  try {
    info = statSync(target);
  } catch {
    return;
  }
  acc.newest = Math.max(acc.newest, info.mtimeMs);
  if (info.isFile()) {
    acc.files++;
    return;
  }
  if (!info.isDirectory()) return;
  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    walkMtimes(path.join(target, name), acc);
  }
}

function mtimeFingerprint(webDir: string, packageRoot: string): WebSourceFingerprint {
  const acc: MtimeAccumulator = { newest: 0, files: 0 };
  for (const input of WEB_MTIME_INPUTS) walkMtimes(path.join(webDir, input), acc);
  let webNames: string[] = [];
  try {
    webNames = readdirSync(webDir);
  } catch {
    // An unreadable web root leaves only src/ in the fingerprint.
  }
  for (const name of webNames) {
    if (/^server-.*\.mjs$/.test(name)) walkMtimes(path.join(webDir, name), acc);
  }
  walkMtimes(path.join(packageRoot, "src"), acc);
  return { kind: "mtime", value: `${Math.floor(acc.newest)}:${acc.files}` };
}

/**
 * Fingerprint the sources the production bundle is built from. `webDir` is
 * the dashboard root; harnery's `src/` sits beside it.
 */
export function computeWebSourceFingerprint(
  webDir: string,
  options: { git?: GitRunner } = {},
): WebSourceFingerprint {
  const packageRoot = path.dirname(path.resolve(webDir));
  return (
    gitFingerprint(packageRoot, options.git ?? defaultGit) ?? mtimeFingerprint(webDir, packageRoot)
  );
}

export function readWebBuildStamp(distDir: string): WebBuildStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(distDir, WEB_BUILD_STAMP_FILE), "utf8"));
    const fingerprint = parsed?.fingerprint;
    if (
      parsed?.version !== STAMP_VERSION ||
      (fingerprint?.kind !== "git" && fingerprint?.kind !== "mtime") ||
      typeof fingerprint?.value !== "string"
    ) {
      return null;
    }
    return parsed as WebBuildStamp;
  } catch {
    return null;
  }
}

export function writeWebBuildStamp(
  distDir: string,
  fingerprint: WebSourceFingerprint,
  now: Date = new Date(),
): void {
  mkdirSync(distDir, { recursive: true });
  const stamp: WebBuildStamp = {
    version: STAMP_VERSION,
    fingerprint,
    built_at: now.toISOString(),
  };
  writeFileSync(path.join(distDir, WEB_BUILD_STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
}

/** Decide whether the build in `distDir` matches `fingerprint`. */
export function checkWebBuildFreshness(
  distDir: string,
  fingerprint: WebSourceFingerprint,
): WebBuildFreshness {
  if (!existsSync(distDir)) {
    return { stale: true, reason: "missing", message: `no production build at ${distDir}` };
  }
  const stamp = readWebBuildStamp(distDir);
  if (!stamp) {
    return {
      stale: true,
      reason: "unstamped",
      message: "the existing build has no source stamp",
    };
  }
  if (
    stamp.fingerprint.kind !== fingerprint.kind ||
    stamp.fingerprint.value !== fingerprint.value
  ) {
    return {
      stale: true,
      reason: "changed",
      message: "dashboard sources changed since the last build",
    };
  }
  return { stale: false };
}

/**
 * Run a build and stamp it on success. The fingerprint is taken before the
 * build starts, so an edit made while the build runs leaves the next start
 * seeing a mismatch rather than a stamp that claims the edit was built.
 */
export function buildAndStamp(
  webDir: string,
  runBuild: () => number,
  options: { fingerprint?: WebSourceFingerprint; git?: GitRunner } = {},
): number {
  const fingerprint = options.fingerprint ?? computeWebSourceFingerprint(webDir, options);
  const status = runBuild();
  if (status === 0) writeWebBuildStamp(webDistDir(webDir), fingerprint);
  return status;
}

export type EnsureWebBuildResult =
  | { ok: true; rebuilt: boolean }
  | { ok: false; status: number; reason: string };

/** Rebuild the dashboard when its production build is missing or stale. */
export function ensureFreshWebBuild(
  webDir: string,
  runBuild: () => number,
  log: (line: string) => void,
  options: { git?: GitRunner } = {},
): EnsureWebBuildResult {
  const fingerprint = computeWebSourceFingerprint(webDir, options);
  const freshness = checkWebBuildFreshness(webDistDir(webDir), fingerprint);
  if (!freshness.stale) return { ok: true, rebuilt: false };
  log(`rebuilding the dashboard: ${freshness.message}`);
  const status = buildAndStamp(webDir, runBuild, { fingerprint });
  if (status !== 0) return { ok: false, status, reason: freshness.message };
  return { ok: true, rebuilt: true };
}
