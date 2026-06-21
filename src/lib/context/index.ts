import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type Heartbeat,
  monorepoRoot,
  readHeartbeat,
  resolveOwner,
} from "../../core/agents/index.ts";
import { exec } from "../exec.ts";
import { NO_DATA } from "../format.ts";

interface SubmoduleStatus {
  name: string;
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  modifiedFiles: number;
  untrackedFiles: number;
}

/**
 * `harn context`: one-shot orientation snapshot for session start / post-compaction
 * recovery / subagent dispatch. Aggregates self / time / repo / commits / submodules
 * / peers, plus opt-in services. Fail-open per section so a missing dependency
 * never blocks the rest from rendering.
 *
 * No process spawns for default sections except git; every other source is
 * filesystem-direct via existing lib helpers.
 */

export type SectionName =
  | "self"
  | "time"
  | "repo"
  | "commits"
  | "submodules"
  | "peers"
  | "services";

export const DEFAULT_SECTIONS: SectionName[] = [
  "self",
  "time",
  "repo",
  "commits",
  "submodules",
  "peers",
];

export const OPT_IN_SECTIONS: SectionName[] = ["services"];

export interface ContextOptions {
  sections?: SectionName[];
  include?: SectionName[];
  showClean?: boolean;
  /** Monorepo root for git ops. Defaults to process.cwd() when omitted. */
  repoRoot?: string;
  /** Submodule names relative to repoRoot. When omitted, submodules section reports an error. */
  submodules?: readonly string[];
}

export interface ContextReport {
  self?: SelfSection | { error: string };
  time?: TimeSection;
  repo?: RepoSection | { error: string };
  commits?: CommitsSection | { error: string };
  submodules?: SubmodulesSection | { error: string };
  peers?: PeersSection | { error: string };
  services?: ServicesSection | { error: string };
  meta: {
    elapsed_ms: number;
    sections_requested: SectionName[];
  };
}

export interface SelfSection {
  name: string | null;
  instance_id: string;
  session_age_secs: number;
  task: string | null;
  last_tool: string | null;
  last_tool_target: string | null;
  files_held: string[];
}

export interface TimeSection {
  chicago: string;
  utc: string;
}

export interface RepoSection {
  cwd: string;
  branch: string;
  ahead: number;
  behind: number;
  modified: number;
  untracked: number;
  staged: number;
}

export interface CommitsSection {
  rows: { sha: string; subject: string }[];
}

export interface SubmodulesSection {
  rows: SubmoduleStatus[];
  clean_omitted: number;
}

export interface PeersSection {
  rows: {
    name: string;
    instance_id_short: string;
    age_min: number;
    files: number;
    last_tool: string | null;
    task: string | null;
  }[];
}

export interface ServicesSection {
  docker_compose: { project: string; service: string; status: string }[];
}

export async function buildContext(opts: ContextOptions = {}): Promise<ContextReport> {
  const started = Date.now();
  const requested = new Set<SectionName>(opts.sections ?? DEFAULT_SECTIONS);
  for (const s of opts.include ?? []) requested.add(s);

  const report: ContextReport = {
    meta: {
      elapsed_ms: 0,
      sections_requested: Array.from(requested),
    },
  };

  const repoRoot = opts.repoRoot ?? process.cwd();
  const submodules = opts.submodules ?? null;
  if (requested.has("self")) report.self = await safe(() => buildSelf());
  if (requested.has("time")) report.time = buildTime();
  if (requested.has("repo")) report.repo = await safe(() => buildRepo(repoRoot));
  if (requested.has("commits")) report.commits = await safe(() => buildCommits(repoRoot));
  if (requested.has("submodules")) {
    report.submodules = await safe(() => buildSubmodules(!!opts.showClean, repoRoot, submodules));
  }
  if (requested.has("peers")) report.peers = await safe(() => buildPeers());
  if (requested.has("services")) report.services = await safe(() => buildServices(repoRoot));

  report.meta.elapsed_ms = Date.now() - started;
  return report;
}

// ─── Sections ──────────────────────────────────────────────────────────────

function buildSelf(): SelfSection {
  const owner = resolveOwner();
  if (!owner) throw new Error("not in an agent session (no pid-map entry)");
  const hb = readHeartbeat(owner);
  if (!hb) throw new Error(`pid-map resolved owner=${owner.slice(0, 8)}… but no heartbeat`);
  const startedMs = Date.parse(hb.started_at);
  const ageSecs = Number.isFinite(startedMs)
    ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000))
    : 0;
  return {
    name: hb.name ?? null,
    instance_id: hb.instance_id,
    session_age_secs: ageSecs,
    task: hb.task ?? null,
    last_tool: hb.last_tool ?? null,
    last_tool_target: hb.last_tool_target ?? null,
    files_held: hb.files_touched ?? [],
  };
}

function buildTime(): TimeSection {
  const now = new Date();
  return {
    chicago: formatChicago(now),
    utc: now.toISOString(),
  };
}

async function buildRepo(repoRoot: string): Promise<RepoSection> {
  const [branchResult, statusResult, aheadBehindResult] = await Promise.all([
    exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot }),
    // trim:false, since porcelain's first line of ` M PATH` would lose its leading
    // space and shift the X/Y status columns, miscounting staged vs modified.
    exec(["git", "status", "--porcelain"], { cwd: repoRoot, trim: false }),
    exec(["git", "rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd: repoRoot }),
  ]);
  const branch = branchResult.stdout || "detached";
  const statusLines = statusResult.stdout ? statusResult.stdout.split("\n") : [];
  let modified = 0;
  let untracked = 0;
  let staged = 0;
  for (const line of statusLines) {
    if (line.startsWith("??")) untracked++;
    else if (line.length >= 2) {
      const x = line[0];
      const y = line[1];
      if (x !== " " && x !== "?") staged++;
      if (y !== " " && y !== "?") modified++;
    }
  }
  let ahead = 0;
  let behind = 0;
  if (aheadBehindResult.exitCode === 0) {
    const parts = aheadBehindResult.stdout.split(/\s+/);
    ahead = Number.parseInt(parts[0] ?? "0", 10);
    behind = Number.parseInt(parts[1] ?? "0", 10);
  }
  return {
    cwd: process.cwd(),
    branch,
    ahead,
    behind,
    modified,
    untracked,
    staged,
  };
}

async function buildCommits(repoRoot: string): Promise<CommitsSection> {
  const result = await exec(["git", "log", "--oneline", "-3", "--no-decorate"], { cwd: repoRoot });
  const rows = result.stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const idx = l.indexOf(" ");
      if (idx < 0) return { sha: l, subject: "" };
      return { sha: l.slice(0, idx), subject: l.slice(idx + 1) };
    });
  return { rows };
}

async function buildSubmodules(
  showClean: boolean,
  repoRoot: string,
  submodules: readonly string[] | null,
): Promise<SubmodulesSection> {
  if (!submodules || submodules.length === 0) {
    throw new Error("no submodules configured (pass submodules via HarneryProgramContext)");
  }
  const all = await Promise.all(
    submodules.map(async (name) => statusFor(name, resolve(repoRoot, name))),
  );
  const rows = showClean ? all : all.filter((s) => s.dirty || s.ahead > 0 || s.behind > 0);
  const cleanOmitted = showClean ? 0 : all.length - rows.length;
  return { rows, clean_omitted: cleanOmitted };
}

async function statusFor(name: string, cwd: string): Promise<SubmoduleStatus> {
  const empty: SubmoduleStatus = {
    name,
    branch: NO_DATA,
    ahead: 0,
    behind: 0,
    dirty: false,
    modifiedFiles: 0,
    untrackedFiles: 0,
  };
  if (!existsSync(cwd)) return empty;
  const [branchR, statusR, abR] = await Promise.all([
    exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
    exec(["git", "status", "--porcelain"], { cwd, trim: false }),
    exec(["git", "rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd }),
  ]);
  let modified = 0;
  let untracked = 0;
  for (const line of statusR.stdout.split("\n")) {
    if (line.startsWith("??")) untracked++;
    else if (line.length >= 2) modified++;
  }
  const [aheadS, behindS] = abR.stdout.split("\t");
  return {
    name,
    branch: branchR.stdout || "detached",
    ahead: Number.parseInt(aheadS ?? "0", 10) || 0,
    behind: Number.parseInt(behindS ?? "0", 10) || 0,
    dirty: modified + untracked > 0,
    modifiedFiles: modified,
    untrackedFiles: untracked,
  };
}

function buildPeers(): PeersSection {
  const root = monorepoRoot();
  if (!root) throw new Error("coord_root() returned null");
  const activeDir = resolve(root, ".harnery", "active");
  if (!existsSync(activeDir)) return { rows: [] };
  const myOwner = resolveOwner();
  // No freshness filter; matches the SessionStart/UserPromptSubmit snapshot.
  // Stale entries get swept by the SessionStart janitor on the next session start.
  const rows: PeersSection["rows"] = [];
  for (const f of readdirSync(activeDir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(resolve(activeDir, f), "utf8")) as Heartbeat;
      if (!hb || typeof hb.instance_id !== "string") continue;
      if (hb.instance_id === myOwner) continue;
      if ((hb.kind ?? "") === "transient") continue;
      const startedMs = Date.parse(hb.started_at);
      const ageMin = Number.isFinite(startedMs) ? Math.floor((Date.now() - startedMs) / 60000) : 0;
      rows.push({
        name: hb.name ?? "unknown",
        instance_id_short: hb.instance_id.slice(0, 8),
        age_min: ageMin,
        files: hb.files_touched?.length ?? 0,
        last_tool: hb.last_tool ?? null,
        task: hb.task ?? null,
      });
    } catch {
      // skip
    }
  }
  // Sort: file-holders first (more activity), then by recency (younger age first).
  rows.sort((a, b) => b.files - a.files || a.age_min - b.age_min);
  return { rows };
}

async function buildServices(repoRoot: string): Promise<ServicesSection> {
  // Probe common compose-file locations at the repo root.
  const candidates = [
    resolve(repoRoot, "docker-compose.yml"),
    resolve(repoRoot, "compose.yml"),
    resolve(repoRoot, "compose.yaml"),
  ];
  const composePath = candidates.find((p) => existsSync(p));
  if (!composePath) {
    return { docker_compose: [] };
  }
  const result = await exec(["docker", "compose", "-f", composePath, "ps", "--format", "json"], {
    cwd: repoRoot,
    timeout: 5000,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `docker compose ps exited ${result.exitCode}`);
  }
  // `docker compose ps --format json` emits one JSON object per line.
  const items: ServicesSection["docker_compose"] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as {
        Project?: string;
        Service?: string;
        State?: string;
        Status?: string;
      };
      items.push({
        project: obj.Project ?? "",
        service: obj.Service ?? "",
        status: obj.Status ?? obj.State ?? "",
      });
    } catch {
      // tolerate non-JSON banner lines
    }
  }
  return { docker_compose: items };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function safe<T>(fn: () => T | Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const CHICAGO_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
  hour12: true,
  timeZone: "America/Chicago",
});

function formatChicago(d: Date): string {
  return CHICAGO_FORMATTER.format(d);
}
