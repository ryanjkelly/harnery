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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Surfaces stalled lifecycle states across the monorepo: plans in-progress
 * too long, open issues gone cold, runbooks that haven't been verified, etc.
 *
 * This is the opposite of `docs --stale`, which flags file-level freshness.
 * Sweep only flags items where the lifecycle state (status header + mtime)
 * suggests attention is needed.
 *
 * Audit files and issue files under `docs/audits/` are explicitly **not**
 * flagged for age; they're immutable records by design.
 *
 * Performance: ages come from one `git log --name-only` per repo (not one
 * `git log` per file). A naive per-file spawn was ~1min+ on large hosts
 * (thousands of topic docs) and looked hung when piped.
 */

export interface SweepOpts {
  repo?: string;
}

export interface SweepItem {
  kind: SweepKind;
  repo: string;
  path: string; // relative to monorepo root
  ageDays: number;
  message: string;
}

export type SweepKind =
  | "stalled-plan" // status: in-progress, untouched >90d
  | "unarchived-shipped" // status: shipped, in plans/ (not archive/) >180d
  | "open-issue-cold" // status: open, untouched >30d
  | "cold-handoff" // status: open, untouched >30d (docs/handoffs/)
  | "runbook-unverified" // docs/runbook.md untouched >180d
  | "topic-doc-stale" // docs/<topic>/... untouched >365d
  | "decisions-dormant"; // docs/decisions.md untouched >180d (active repos)

const STALLED_PLAN_DAYS = 90;
const UNARCHIVED_SHIPPED_DAYS = 180;
const OPEN_ISSUE_DAYS = 30;
const COLD_HANDOFF_DAYS = 30;
const RUNBOOK_DAYS = 180;
const TOPIC_DOC_DAYS = 365;
const DECISIONS_DORMANT_DAYS = 180;

type AgeMap = Map<string, number>;

/**
 * Parse a `git log --format="COMMIT %aI" --name-only` body into
 * repo-relative path → age in days. Newest commit wins.
 * Exported for unit tests.
 */
export function parseDocsAgeLog(stdout: string, nowMs: number = Date.now()): AgeMap {
  const ages: AgeMap = new Map();
  let currentAge: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("COMMIT ")) {
      const iso = line.slice("COMMIT ".length).trim();
      const ms = Date.parse(iso);
      currentAge = Number.isNaN(ms) ? null : Math.floor((nowMs - ms) / (1000 * 60 * 60 * 24));
      continue;
    }
    if (!line || currentAge == null) continue;
    if (!line.endsWith(".md")) continue;
    // First (newest) sighting wins
    if (!ages.has(line)) ages.set(line, currentAge);
  }
  return ages;
}

/**
 * One `git log --name-only` for the whole docs/ tree. Docs histories are
 * small even without --since (a large host's full docs log is ~5k lines / <100ms),
 * so we take the full history for accurate ages on old files.
 */
async function loadDocsAges(cwd: string): Promise<AgeMap> {
  const result = await sh(`git log --format="COMMIT %aI" --name-only -- docs/`, {
    cwd,
    timeout: 120_000,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return new Map();
  return parseDocsAgeLog(result.stdout);
}

/** Age for a tracked path, or null if untracked / never under docs/. */
function ageDays(ages: AgeMap, rel: string): number | null {
  return ages.has(rel) ? ages.get(rel)! : null;
}

/** Days since ANY commit in the repo (measures repo activity) */
async function lastRepoCommitAgeDays(cwd: string): Promise<number | null> {
  const result = await sh("git log -1 --format=%aI", { cwd });
  if (result.exitCode !== 0 || !result.stdout.trim()) return null;
  const ms = Date.now() - new Date(result.stdout.trim()).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function readStatus(filePath: string): string | null {
  try {
    const content = readFileSync(filePath, "utf8");
    const head = content.split("\n").slice(0, 20).join("\n");
    const m = head.match(/\*\*Status:\*\*\s*([a-zA-Z][a-zA-Z-]*)/);
    return m ? m[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

function walkMdFiles(dir: string, skipReadme = false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync> | undefined;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkMdFiles(full, skipReadme));
    } else if (entry.endsWith(".md") && !(skipReadme && entry === "README.md")) {
      out.push(full);
    }
  }
  return out;
}

function sweepPlans(repoName: string, repoPath: string, ages: AgeMap, items: SweepItem[]): void {
  const plansDir = join(repoPath, "docs", "plans");
  if (!existsSync(plansDir)) return;

  for (const full of walkMdFiles(plansDir, true)) {
    const rel = relative(repoPath, full);
    const displayPath = join(repoName === "(root)" ? "" : repoName, rel);
    const isArchived = rel.includes("/archive/");
    const status = readStatus(full);
    const age = ageDays(ages, rel);
    if (age == null) continue;

    if (!isArchived && status === "in-progress" && age > STALLED_PLAN_DAYS) {
      items.push({
        kind: "stalled-plan",
        repo: repoName,
        path: displayPath,
        ageDays: age,
        message: `plan is in-progress, last touched ${age}d ago; confirm still active or bump status`,
      });
    }
    if (!isArchived && status === "shipped" && age > UNARCHIVED_SHIPPED_DAYS) {
      items.push({
        kind: "unarchived-shipped",
        repo: repoName,
        path: displayPath,
        ageDays: age,
        message: `plan is shipped but still in docs/plans/ after ${age}d; move to docs/plans/archive/`,
      });
    }
  }
}

function sweepIssues(repoName: string, repoPath: string, ages: AgeMap, items: SweepItem[]): void {
  const issuesDir = join(repoPath, "docs", "issues");
  if (!existsSync(issuesDir)) return;

  for (const entry of readdirSync(issuesDir)) {
    if (!entry.endsWith(".md") || entry === "README.md") continue;
    const full = join(issuesDir, entry);
    const rel = join("docs", "issues", entry);
    const displayPath = join(repoName === "(root)" ? "" : repoName, rel);
    const status = readStatus(full);
    if (status !== "open") continue;
    const age = ageDays(ages, rel);
    if (age == null || age <= OPEN_ISSUE_DAYS) continue;
    items.push({
      kind: "open-issue-cold",
      repo: repoName,
      path: displayPath,
      ageDays: age,
      message: `issue still marked open after ${age}d; resolve, mark wontfix, or triage`,
    });
  }
}

function sweepHandoffs(repoName: string, repoPath: string, ages: AgeMap, items: SweepItem[]): void {
  const handoffsDir = join(repoPath, "docs", "handoffs");
  if (!existsSync(handoffsDir)) return;

  for (const full of walkMdFiles(handoffsDir)) {
    const rel = relative(repoPath, full);
    const status = readStatus(full);
    if (status !== "open") continue;
    const age = ageDays(ages, rel);
    if (age == null || age <= COLD_HANDOFF_DAYS) continue;
    const displayPath = join(repoName === "(root)" ? "" : repoName, rel);
    items.push({
      kind: "cold-handoff",
      repo: repoName,
      path: displayPath,
      ageDays: age,
      message: `handoff still marked open after ${age}d; resolve, abandon, or note current progress`,
    });
  }
}

function sweepRunbook(repoName: string, repoPath: string, ages: AgeMap, items: SweepItem[]): void {
  const runbook = join(repoPath, "docs", "runbook.md");
  if (!existsSync(runbook)) return;
  const age = ageDays(ages, "docs/runbook.md");
  if (age == null || age <= RUNBOOK_DAYS) return;
  const displayPath = join(repoName === "(root)" ? "" : repoName, "docs/runbook.md");
  items.push({
    kind: "runbook-unverified",
    repo: repoName,
    path: displayPath,
    ageDays: age,
    message: `runbook hasn't been edited in ${age}d; re-verify procedures`,
  });
}

function sweepTopicDocs(
  repoName: string,
  repoPath: string,
  ages: AgeMap,
  items: SweepItem[],
): void {
  const docsDir = join(repoPath, "docs");
  if (!existsSync(docsDir)) return;

  // Skip known date-stamped or lifecycle-managed dirs (and vendor dumps).
  // handoffs/inquiries are lifecycle-managed elsewhere; vendors match the
  // docs freshness scanner's IGNORE_DIRS.
  const skipDirs = new Set([
    "audits",
    "issues",
    "plans",
    "changelogs",
    "emails", // parent-specific
    "handoffs",
    "inquiries",
    "vendors",
  ]);

  for (const entry of readdirSync(docsDir)) {
    if (skipDirs.has(entry)) continue;
    const full = join(docsDir, entry);
    let st: ReturnType<typeof statSync> | undefined;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    for (const full2 of walkMdFiles(full)) {
      const rel = relative(repoPath, full2);
      const age = ageDays(ages, rel);
      if (age == null || age <= TOPIC_DOC_DAYS) continue;
      const displayPath = join(repoName === "(root)" ? "" : repoName, rel);
      items.push({
        kind: "topic-doc-stale",
        repo: repoName,
        path: displayPath,
        ageDays: age,
        message: `topic doc untouched for ${age}d; confirm still accurate or archive`,
      });
    }
  }
}

async function sweepDecisions(
  repoName: string,
  repoPath: string,
  ages: AgeMap,
  items: SweepItem[],
): Promise<void> {
  const decisions = join(repoPath, "docs", "decisions.md");
  if (!existsSync(decisions)) return;
  const age = ageDays(ages, "docs/decisions.md");
  const repoAge = await lastRepoCommitAgeDays(repoPath);
  if (age == null || repoAge == null) return;
  // Only flag if the repo is active (recent commits) but decisions haven't moved
  if (age <= DECISIONS_DORMANT_DAYS) return;
  if (repoAge > 30) return; // repo itself is dormant, nothing to decide
  const displayPath = join(repoName === "(root)" ? "" : repoName, "docs/decisions.md");
  items.push({
    kind: "decisions-dormant",
    repo: repoName,
    path: displayPath,
    ageDays: age,
    message: `repo is active but decisions.md hasn't been appended to in ${age}d; any architectural choices undocumented?`,
  });
}

export async function runSweep(opts: SweepOpts): Promise<SweepItem[]> {
  const targets: { name: string; path: string }[] = [{ name: "(root)", path: REPO_ROOT }];
  for (const name of SUBMODULES) {
    if (!isSubmoduleInitialized(name)) continue;
    targets.push({ name, path: submodulePath(name) });
  }

  const filter = opts.repo === "." ? "(root)" : opts.repo;
  const filtered = filter ? targets.filter((t) => t.name === filter) : targets;

  const items: SweepItem[] = [];
  // Load ages per repo in parallel — one git log each, not one per file.
  const ageMaps = await Promise.all(filtered.map((t) => loadDocsAges(t.path)));

  for (let i = 0; i < filtered.length; i++) {
    const { name, path } = filtered[i]!;
    const ages = ageMaps[i]!;
    sweepPlans(name, path, ages, items);
    sweepIssues(name, path, ages, items);
    sweepHandoffs(name, path, ages, items);
    sweepRunbook(name, path, ages, items);
    sweepTopicDocs(name, path, ages, items);
    await sweepDecisions(name, path, ages, items);
  }

  // Sort by severity proxy: oldest first within kind
  items.sort((a, b) => b.ageDays - a.ageDays);
  return items;
}

/**
 * Cheap parent-repo-only count of `cold-handoff` items, used by `docs lint`
 * to print a one-line nudge without running the full sweep across every
 * submodule (handoffs live under the parent's docs/handoffs/ by convention).
 */
export async function countColdHandoffs(): Promise<number> {
  const items: SweepItem[] = [];
  const ages = await loadDocsAges(REPO_ROOT);
  sweepHandoffs("(root)", REPO_ROOT, ages, items);
  return items.length;
}
