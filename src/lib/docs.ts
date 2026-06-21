import { existsSync as __existsSyncForDocs } from "node:fs";
import { resolve as __resolveForDocs } from "node:path";
import { sh } from "./exec.ts";

// Module-level docs context, initialized by initDocsContext() before any
// other function in this file is called. The repo root + submodule list
// are passed via the context provided to registerDocsCommand.
let REPO_ROOT = "";
let SUBMODULES: readonly string[] = [];

export function initDocsContext(opts: { repoRoot: string; submodules: readonly string[] }): void {
  REPO_ROOT = opts.repoRoot;
  SUBMODULES = opts.submodules;
}

function submodulePath(name: string): string {
  return __resolveForDocs(REPO_ROOT, name);
}

function isSubmoduleInitialized(name: string): boolean {
  return __existsSyncForDocs(__resolveForDocs(REPO_ROOT, name, ".git"));
}

export interface DocCommit {
  date: string; // ISO date string
  message: string; // First line of commit message
}

export interface DocFileInfo {
  path: string; // Relative to repo root (e.g., "docs/foo.md" or "subdir/README.md")
  dir: string; // Top-level directory (e.g., "docs", "subdir", "(root)")
  commits: DocCommit[];
  lastCommitDate: string | null; // ISO date or null if untracked
  lastCommitAgeDays: number | null; // Days since last commit, or null if untracked
  untracked: boolean;
}

/** Directories/patterns to skip even within git-tracked files */
const SKIP_PATTERNS = [
  /\/\.cursor\//,
  /\/\.claude\//,
  /\/\.pytest_cache\//,
  /\/AGENTS\.md$/, // Auto-generated
];

/** Top-level directories to ignore by default (path prefix match) */
const IGNORE_DIRS = ["docs/vendors"];

/**
 * Scan for .md files across the parent repo and all submodules.
 * Uses `git ls-files` to only find tracked files (skips .venv, node_modules, etc.).
 */
export async function scanDocs(opts: {
  commitCount?: number;
  dir?: string;
  noSubmodules?: boolean;
  staleDays?: number;
}): Promise<DocFileInfo[]> {
  const commitCount = opts.commitCount ?? 1;
  const now = Date.now();

  // Collect tracked .md files from parent repo
  const parentFiles = await getTrackedMdFiles(REPO_ROOT, "");

  // Collect tracked .md files from each initialized submodule (unless --no-submodules)
  let submoduleFiles: string[] = [];
  if (!opts.noSubmodules) {
    const submoduleResults = await Promise.all(
      SUBMODULES.filter(isSubmoduleInitialized).map(async (name) => {
        const cwd = submodulePath(name);
        return getTrackedMdFiles(cwd, name);
      }),
    );
    submoduleFiles = submoduleResults.flat();
  }

  let allFiles = [...parentFiles, ...submoduleFiles];

  // Filter out skipped patterns and ignored directories
  allFiles = allFiles.filter(
    (f) =>
      !SKIP_PATTERNS.some((p) => p.test(`/${f}`)) &&
      !IGNORE_DIRS.some((d) => f.startsWith(`${d}/`)),
  );

  // Filter by directory if specified
  if (opts.dir) {
    // Treat "." as an alias for "(root)", the natural way to say "root-level files"
    const dirFilter = opts.dir === "." ? "(root)" : opts.dir.toLowerCase();
    allFiles = allFiles.filter((f) => {
      const topDir = getTopDir(f).toLowerCase();
      // Exact match first, fall back to substring
      return topDir === dirFilter || topDir.includes(dirFilter);
    });
  }

  // Fetch git history for all files, batched in parallel groups of 20
  const results: DocFileInfo[] = [];
  const batchSize = 20;

  for (let i = 0; i < allFiles.length; i += batchSize) {
    const batch = allFiles.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((filePath) => getFileInfo(filePath, commitCount, now)),
    );
    results.push(...batchResults);
  }

  // Filter by stale days if specified
  if (opts.staleDays) {
    const minAge = opts.staleDays;
    return results.filter(
      (r) => r.untracked || (r.lastCommitAgeDays !== null && r.lastCommitAgeDays >= minAge),
    );
  }

  return results;
}

/** Get top-level directory for grouping */
function getTopDir(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length === 1) return "(root)";
  return parts[0]!;
}

/** Get tracked .md files from a git repo */
async function getTrackedMdFiles(cwd: string, prefix: string): Promise<string[]> {
  // Use shell to avoid pathspec vs glob ambiguity; ** ensures recursive matching
  const result = await sh('git ls-files --cached "**/*.md" "*.md"', { cwd });
  if (result.exitCode !== 0 || !result.stdout) return [];

  return result.stdout
    .split("\n")
    .filter((f) => f.endsWith(".md"))
    .map((f) => (prefix ? `${prefix}/${f}` : f));
}

/** Get file info with git history */
async function getFileInfo(
  filePath: string,
  commitCount: number,
  now: number,
): Promise<DocFileInfo> {
  const dir = getTopDir(filePath);

  // Determine which repo to query and the relative path within it
  const { cwd, relativePath } = resolveFilePath(filePath);

  const logResult = await sh(`git log -${commitCount} --format="%aI%x09%s" -- "${relativePath}"`, {
    cwd,
  });

  if (logResult.exitCode !== 0 || !logResult.stdout.trim()) {
    return {
      path: filePath,
      dir,
      commits: [],
      lastCommitDate: null,
      lastCommitAgeDays: null,
      untracked: true,
    };
  }

  const commits: DocCommit[] = logResult.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [date, ...msgParts] = line.split("\t");
      return { date: date!, message: msgParts.join("\t") };
    });

  const lastDate = commits[0]?.date ?? null;
  const ageDays = lastDate
    ? Math.floor((now - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return {
    path: filePath,
    dir,
    commits,
    lastCommitDate: lastDate,
    lastCommitAgeDays: ageDays,
    untracked: false,
  };
}

/** Resolve a monorepo-relative path to the correct git repo cwd + relative path */
function resolveFilePath(filePath: string): { cwd: string; relativePath: string } {
  for (const name of SUBMODULES) {
    if (filePath.startsWith(`${name}/`)) {
      return {
        cwd: submodulePath(name),
        relativePath: filePath.slice(name.length + 1),
      };
    }
  }
  return { cwd: REPO_ROOT, relativePath: filePath };
}
