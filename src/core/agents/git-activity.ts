// Commits in progress, attributed to the agent session that started them.
//
// A commit can hold a repository's index lock for minutes while its
// pre-commit checks run. Git records no owner for that lock, so a peer
// blocked behind it could only say "another Git process". The pre-commit
// hook already knows which session is committing; it records that here, and
// the post-commit hook removes the record. A commit that fails or is killed
// leaves its record behind, but the record names the git process and its
// start token, so readers drop it as soon as that process is gone.
//
// Layout: <coordRoot>/.harnery/git-activity/<git pid>.json, one file per
// commit in progress. Nothing here ever blocks a commit: every write and
// read is best-effort.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  type AdmissionEntry,
  admissionBaseDir,
  admissionStatus,
  listAdmissionResources,
} from "../../lib/admission.ts";
import { processMayBeAlive } from "../../lib/process-alive.ts";
import { readPpid, resolveOwner } from "../hooks/resolve/owner.ts";
import { resolveName } from "./state/names.ts";
import { processStartToken, verifyProcessGeneration } from "./state/proc-start.ts";

export const GIT_ACTIVITY_SCHEMA_VERSION = 1;

export interface GitCommitActivity {
  schema_version: number;
  /** Coordination instance that started the commit. */
  instance_id: string;
  /** Display name of that session, without the `agent-` prefix, when known. */
  agent?: string;
  /** Absolute path of the repository's working tree. */
  repo: string;
  /** The `git commit` process holding the index lock. */
  git_pid: number;
  /** Start token of that process, so a reused pid cannot keep a record alive. */
  git_start?: string;
  /** When the pre-commit hook recorded the commit. */
  started_at: string;
}

/** A session's identity as an admission holder or commit record carries it. */
export interface AgentIdentity {
  instance_id: string;
  agent?: string;
}

/** A live commit plus the build-slot holds its session has open right now. */
export interface GitCommitActivityView extends GitCommitActivity {
  /** Labels of admission slots the same session currently holds. */
  slots: string[];
}

function activityDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "git-activity");
}

/** `agent-<Name>` when the name is known, else the short instance id. */
export function agentLabel(identity: AgentIdentity): string {
  return identity.agent ? `agent-${identity.agent}` : `agent-${identity.instance_id.slice(0, 8)}`;
}

/**
 * The calling process's session, resolved the same way commit verdicts are:
 * environment, then the pid-map walk. Null when nothing resolves; callers
 * record nothing rather than guess.
 */
export function resolveAgentIdentity(coordRoot: string): AgentIdentity | null {
  try {
    const owner = resolveOwner({ payload: null, coordRoot });
    if (!owner) return null;
    const name = resolveName(coordRoot, owner.instance_id)?.name;
    return { instance_id: owner.instance_id, ...(name ? { agent: name } : {}) };
  } catch {
    return null;
  }
}

function processName(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
  } catch {
    /* no /proc: fall through to ps */
  }
  try {
    const out = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (out.status === 0) return out.stdout.trim().split("/").pop() ?? null;
  } catch {
    /* ps unavailable */
  }
  return null;
}

/** The nearest ancestor of this process that is git itself, or null. */
export function findGitAncestor(
  startPid: number = process.pid,
  deps: { ppid?: (pid: number) => number | null; name?: (pid: number) => string | null } = {},
): number | null {
  const ppid = deps.ppid ?? readPpid;
  const name = deps.name ?? processName;
  let pid: number | null = ppid(startPid);
  for (let hops = 0; pid && pid > 1 && hops < 20; hops++) {
    const comm = name(pid);
    if (comm === "git" || comm === "git.exe") return pid;
    pid = ppid(pid);
  }
  return null;
}

function repoToplevel(cwd: string): string | null {
  const out = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return out.status === 0 ? out.stdout.trim() || null : null;
}

/**
 * Record that the session behind this hook started a commit in the
 * repository at `cwd`. Called from the pre-commit hook; best-effort.
 */
export function recordCommitStart(
  coordRoot: string,
  cwd: string,
  deps: {
    identity?: AgentIdentity | null;
    gitPid?: number | null;
    repo?: string | null;
    now?: Date;
  } = {},
): GitCommitActivity | null {
  try {
    const identity = deps.identity !== undefined ? deps.identity : resolveAgentIdentity(coordRoot);
    if (!identity) return null;
    const gitPid = deps.gitPid !== undefined ? deps.gitPid : findGitAncestor();
    if (!gitPid) return null;
    const repo = deps.repo !== undefined ? deps.repo : repoToplevel(cwd);
    if (!repo) return null;
    const start = processStartToken(gitPid);
    const record: GitCommitActivity = {
      schema_version: GIT_ACTIVITY_SCHEMA_VERSION,
      instance_id: identity.instance_id,
      ...(identity.agent ? { agent: identity.agent } : {}),
      repo: resolve(repo),
      git_pid: gitPid,
      ...(start ? { git_start: start } : {}),
      started_at: (deps.now ?? new Date()).toISOString(),
    };
    const dir = activityDir(coordRoot);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${gitPid}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record)}\n`);
    renameSync(tmp, file);
    return record;
  } catch {
    return null;
  }
}

/** Remove the record for the commit this hook belongs to. Best-effort. */
export function clearCommitActivity(coordRoot: string, gitPid?: number | null): void {
  try {
    const pid = gitPid !== undefined ? gitPid : findGitAncestor();
    if (!pid) return;
    unlinkSync(join(activityDir(coordRoot), `${pid}.json`));
  } catch {
    /* already gone */
  }
}

function recordIsLive(
  record: GitCommitActivity,
  deps: { alive?: (pid: number) => boolean; generation?: typeof verifyProcessGeneration },
): boolean {
  const alive = deps.alive ?? processMayBeAlive;
  if (!alive(record.git_pid)) return false;
  const generation = deps.generation ?? verifyProcessGeneration;
  return generation(record.git_pid, record.git_start) !== "different";
}

function parseRecord(raw: string): GitCommitActivity | null {
  try {
    const value = JSON.parse(raw) as Partial<GitCommitActivity>;
    if (
      typeof value.instance_id !== "string" ||
      typeof value.repo !== "string" ||
      typeof value.git_pid !== "number" ||
      typeof value.started_at !== "string"
    ) {
      return null;
    }
    return value as GitCommitActivity;
  } catch {
    return null;
  }
}

/**
 * Every commit still in progress. Records whose git process has exited, or
 * whose pid now belongs to a different process, are removed on the way.
 */
export function listCommitActivity(
  coordRoot: string,
  deps: { alive?: (pid: number) => boolean; generation?: typeof verifyProcessGeneration } = {},
): GitCommitActivity[] {
  const dir = activityDir(coordRoot);
  if (!existsSync(dir)) return [];
  const live: GitCommitActivity[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    let record: GitCommitActivity | null = null;
    try {
      record = parseRecord(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (record && recordIsLive(record, deps)) {
      live.push(record);
      continue;
    }
    try {
      unlinkSync(file);
    } catch {
      /* a peer removed it first */
    }
  }
  return live.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

/** Admission holders across every resource, for joining onto commit records. */
export function listAdmissionHolders(dir: string = admissionBaseDir()): AdmissionEntry[] {
  try {
    return listAdmissionResources(dir).flatMap(
      (resource) => admissionStatus({ dir, resource }).holders,
    );
  } catch {
    return [];
  }
}

/**
 * Live commits in the given repositories, optionally excluding one session,
 * each with the build-slot holds its session has open.
 */
export function commitActivityFor(
  coordRoot: string,
  options: {
    repos?: readonly string[];
    excludeInstance?: string;
    activity?: readonly GitCommitActivity[];
    holders?: readonly AdmissionEntry[];
  } = {},
): GitCommitActivityView[] {
  const wanted = options.repos ? new Set(options.repos.map((repo) => resolve(repo))) : null;
  const activity = (options.activity ?? listCommitActivity(coordRoot)).filter(
    (record) =>
      (!wanted || wanted.has(resolve(record.repo))) &&
      record.instance_id !== options.excludeInstance,
  );
  if (activity.length === 0) return [];
  const holders = options.holders ?? listAdmissionHolders();
  return activity.map((record) => ({
    ...record,
    slots: holders
      .filter((holder) => holder.instance_id === record.instance_id)
      .map((holder) => holder.label),
  }));
}

/** Whole minutes, or seconds under a minute. */
export function formatElapsed(fromIso: string, now: Date = new Date()): string {
  const ms = Math.max(0, now.getTime() - Date.parse(fromIso));
  if (!Number.isFinite(ms)) return "unknown time";
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
}

/**
 * One plain line: who is committing where, for how long, and which checks
 * hold a build slot. `root` makes the repository path relative for display.
 */
export function describeCommitActivity(
  view: GitCommitActivityView,
  options: { root?: string; now?: Date } = {},
): string {
  const where = options.root ? relative(options.root, view.repo) || "." : view.repo;
  const slots = view.slots.length > 0 ? `; running ${view.slots.join(", ")}` : "";
  return `${where}: ${agentLabel(view)} has been committing for ${formatElapsed(view.started_at, options.now)}${slots}`;
}
