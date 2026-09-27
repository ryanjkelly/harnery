/**
 * Decide, per launch, whether a workflow worker runs without its vendor sandbox
 * (ADR 0192).
 *
 * A worker gets full access only when three independent things agree:
 *
 * 1. The host project enabled it. Harnery ships it off.
 * 2. The session that launched the run can itself be shown to have full
 *    access. A sandboxed parent never hands more access to a child than it
 *    holds, and a parent whose access cannot be established counts as
 *    sandboxed.
 * 3. The worker's model and effort meet a floor the host configured for that
 *    adapter.
 *
 * Every other case keeps the ordinary sandboxed projection, byte for byte. The
 * decision is recorded on every launch, so a run states what each worker was
 * allowed to do and why.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { builtinAdapterProfile } from "../adapters/profiles.ts";
import type { ParentAccessEvidence, SpawnFilesystemPolicy, WorkerAccessDecision } from "./types.ts";

/** One model an adapter's worker may run unsandboxed on. `minEffort` is on the
 * adapter's declared effort scale; it is required for an adapter that has one
 * and refused for an adapter that does not (whose effort lives in the model id). */
export interface WorkerFullAccessFloor {
  model: string;
  minEffort?: string;
}

export interface WorkerFullAccessPolicy {
  enabled: boolean;
  floors: Readonly<Record<string, readonly WorkerFullAccessFloor[]>>;
  /** Set when the configured value could not be validated. An invalid policy
   * is disabled as a whole rather than partially honored. */
  invalid?: string;
}

export const DISABLED_WORKER_FULL_ACCESS: WorkerFullAccessPolicy = Object.freeze({
  enabled: false,
  floors: Object.freeze({}),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): WorkerFullAccessPolicy {
  return { enabled: false, floors: {}, invalid: message };
}

/**
 * Validate the raw `workflow.workerFullAccess` config value.
 *
 * Absent means disabled. Anything malformed disables the whole policy and says
 * why, because honoring the valid half of a half-valid trust grant would hand
 * out access the host never cleanly stated.
 */
export function parseWorkerFullAccessPolicy(raw: unknown): WorkerFullAccessPolicy {
  if (raw === undefined || raw === null) return DISABLED_WORKER_FULL_ACCESS;
  if (!isPlainObject(raw)) return invalid("workflow.workerFullAccess must be an object");
  for (const key of Object.keys(raw)) {
    if (key !== "enabled" && key !== "floors") {
      return invalid(`workflow.workerFullAccess has unknown key ${JSON.stringify(key)}`);
    }
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    return invalid("workflow.workerFullAccess.enabled must be a boolean");
  }
  const floorsRaw = raw.floors ?? {};
  if (!isPlainObject(floorsRaw))
    return invalid("workflow.workerFullAccess.floors must be an object");
  const floors: Record<string, WorkerFullAccessFloor[]> = {};
  for (const [adapter, entries] of Object.entries(floorsRaw)) {
    const profile = builtinAdapterProfile(adapter);
    if (!profile) {
      return invalid(
        `workflow.workerFullAccess.floors names unknown adapter ${JSON.stringify(adapter)}`,
      );
    }
    if (!Array.isArray(entries)) {
      return invalid(`workflow.workerFullAccess.floors.${adapter} must be an array`);
    }
    const parsed: WorkerFullAccessFloor[] = [];
    for (const entry of entries) {
      if (!isPlainObject(entry)) {
        return invalid(`workflow.workerFullAccess.floors.${adapter} entries must be objects`);
      }
      for (const key of Object.keys(entry)) {
        if (key !== "model" && key !== "minEffort") {
          return invalid(
            `workflow.workerFullAccess.floors.${adapter} entry has unknown key ${JSON.stringify(key)}`,
          );
        }
      }
      const model = typeof entry.model === "string" ? entry.model.trim() : "";
      if (!model) {
        return invalid(`workflow.workerFullAccess.floors.${adapter} entry needs a model id`);
      }
      const minEffort = entry.minEffort;
      if (profile.effortValues.length > 0) {
        if (typeof minEffort !== "string" || !profile.effortValues.includes(minEffort)) {
          return invalid(
            `workflow.workerFullAccess.floors.${adapter} entry for ${model} needs minEffort, one of: ${profile.effortValues.join(", ")}`,
          );
        }
        parsed.push({ model, minEffort });
      } else {
        if (minEffort !== undefined) {
          return invalid(
            `workflow.workerFullAccess.floors.${adapter} has no effort scale; name the exact model id instead of minEffort`,
          );
        }
        parsed.push({ model });
      }
    }
    floors[adapter] = parsed;
  }
  return { enabled: raw.enabled === true, floors };
}

export interface WorkerAccessInput {
  adapter: string;
  model?: string;
  effort?: string;
  policy: WorkerFullAccessPolicy;
  /** The run's filesystem policy, if the host requested one. */
  filesystemPolicy?: SpawnFilesystemPolicy;
  /** Called at most when every cheaper condition already allows full access. */
  parent: () => ParentAccessEvidence;
}

const sandboxed = (
  reason: WorkerAccessDecision["reason"],
  detail: string,
): WorkerAccessDecision => ({
  mode: "sandboxed",
  reason,
  detail,
});

/**
 * The access decision for one launch. Conditions are checked from the host's
 * own configuration outward, so the recorded reason names the first thing that
 * kept the sandbox in place.
 */
export function decideWorkerAccess(input: WorkerAccessInput): WorkerAccessDecision {
  const { adapter, policy } = input;
  if (policy.invalid) {
    return sandboxed("config_invalid", `worker full access is off: ${policy.invalid}`);
  }
  if (!policy.enabled) {
    return sandboxed("disabled", "the host has not enabled worker full access");
  }
  if (!builtinAdapterProfile(adapter)?.fullAccess) {
    return sandboxed("adapter_unrepresentable", `${adapter} declares no full-access mode`);
  }
  if (input.filesystemPolicy?.mode === "read-only") {
    // A read-only policy is a deliberate constraint on this run's children, not
    // a sandbox limitation to route around.
    return sandboxed("policy_read_only", "the run requested a read-only filesystem policy");
  }
  const floors = policy.floors[adapter] ?? [];
  if (floors.length === 0) {
    return sandboxed("model_not_listed", `no full-access floor is configured for ${adapter}`);
  }
  if (!input.model) {
    return sandboxed(
      "model_unset",
      "the worker names no model, so the adapter default cannot be checked against a floor",
    );
  }
  const matching = floors.filter((floor) => floor.model === input.model);
  if (matching.length === 0) {
    return sandboxed(
      "model_not_listed",
      `${input.model} is not on the ${adapter} full-access list`,
    );
  }
  const scale = builtinAdapterProfile(adapter)?.effortValues ?? [];
  if (scale.length > 0) {
    if (!input.effort) {
      return sandboxed(
        "effort_unset",
        `the worker names no effort, so ${input.model} cannot be checked against its floor`,
      );
    }
    const rank = scale.indexOf(input.effort);
    const floor = matching.find(
      (entry) => entry.minEffort !== undefined && rank >= scale.indexOf(entry.minEffort),
    );
    if (rank < 0 || !floor) {
      const needed = matching.map((entry) => entry.minEffort).join(" or ");
      return sandboxed(
        "effort_below_floor",
        `${input.model} at effort ${input.effort} is below the ${needed} floor`,
      );
    }
  }
  const parent = input.parent();
  if (parent.state === "sandboxed") {
    return sandboxed("parent_sandboxed", `the launching session is sandboxed: ${parent.detail}`);
  }
  if (parent.state !== "full-access") {
    return sandboxed(
      "parent_unknown",
      `the launching session's access could not be established: ${parent.detail}`,
    );
  }
  const effortPart = input.effort ? ` at effort ${input.effort}` : "";
  return {
    mode: "full-access",
    reason: "qualified",
    detail: `${input.model}${effortPart} meets the ${adapter} floor and ${parent.detail}`,
  };
}

// ---------------------------------------------------------------------------
// Parent access detection
// ---------------------------------------------------------------------------

export interface ParentAccessDeps {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homeDir: string;
  /** Contents of /proc/self/status, or null when unreadable. */
  procStatus: () => string | null;
  /** Windows user profile roots visible from a WSL guest. */
  windowsUserRoots: () => string[];
}

function defaultDeps(): ParentAccessDeps {
  return {
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
    procStatus: () => {
      try {
        return readFileSync("/proc/self/status", "utf8");
      } catch {
        return null;
      }
    },
    windowsUserRoots: () => {
      try {
        return readdirSync("/mnt/c/Users").map((name) => join("/mnt/c/Users", name));
      } catch {
        return [];
      }
    },
  };
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

type Verdict = { state: ParentAccessEvidence["state"]; detail: string };

/**
 * Establish whether the session that launched this process runs without a
 * sandbox. Only positive evidence counts.
 *
 * Every adapter session marker in the environment has to prove full access on
 * its own. A nested launch (one agent CLI inside another) inherits both
 * markers, and the outer session's sandbox would still bind the inner one, so
 * one sandboxed or unprovable marker is enough to keep workers sandboxed.
 *
 * - Process confinement is checked first. On Linux, the Codex and Claude Code
 *   sandboxes both set `no_new_privs`, and Codex also exports
 *   `CODEX_SANDBOX*` variables. Either one means this process is confined.
 * - Codex: the thread's rollout file must show the latest turn ran under the
 *   `danger-full-access` sandbox policy.
 * - Claude Code: the session transcript's latest permission mode must be
 *   `bypassPermissions`. Claude Code's Bash sandbox is covered by the Linux
 *   confinement check; on other platforms it cannot be ruled out, so a Claude
 *   Code parent there is unknown.
 * - Cursor and OpenCode record no readable access state, so they are unknown.
 */
export function detectParentAccess(deps: ParentAccessDeps = defaultDeps()): ParentAccessEvidence {
  const env = deps.env;
  const markers: Array<{ adapter: string; id: string }> = [];
  const claudeId = nonEmpty(env.CLAUDE_CODE_SESSION_ID);
  if (claudeId) markers.push({ adapter: "claude-code", id: claudeId });
  const codexId = nonEmpty(env.CODEX_THREAD_ID);
  if (codexId) markers.push({ adapter: "codex", id: codexId });
  const cursorId = nonEmpty(env.CURSOR_SESSION_ID) ?? nonEmpty(env.CURSOR_CONVERSATION_ID);
  if (cursorId) markers.push({ adapter: "cursor", id: cursorId });
  const openCodeId = nonEmpty(env.OPENCODE_SESSION_ID);
  if (openCodeId) markers.push({ adapter: "opencode", id: openCodeId });
  const adapters = markers.map((marker) => marker.adapter);
  const result = (verdict: Verdict): ParentAccessEvidence => ({ ...verdict, adapters });

  if (markers.length === 0) {
    return result({ state: "unknown", detail: "no adapter session marker is present" });
  }
  const sandboxVars = Object.keys(env).filter(
    (key) => key.startsWith("CODEX_SANDBOX") && nonEmpty(env[key]),
  );
  if (sandboxVars.length > 0) {
    return result({ state: "sandboxed", detail: `${sandboxVars.join(", ")} is set` });
  }
  let confinement: Verdict;
  if (deps.platform === "linux") {
    const status = deps.procStatus();
    const match = status?.match(/^NoNewPrivs:\s*(\d)/m);
    if (!match) {
      return result({ state: "unknown", detail: "process confinement could not be read" });
    }
    if (match[1] !== "0") {
      return result({ state: "sandboxed", detail: "this process runs with no_new_privs set" });
    }
    confinement = { state: "full-access", detail: "no_new_privs is clear" };
  } else {
    confinement = { state: "unknown", detail: `no confinement probe on ${deps.platform}` };
  }

  const verdicts: Verdict[] = [];
  for (const marker of markers) {
    if (marker.adapter === "codex") {
      verdicts.push(codexParentAccess(marker.id, deps));
    } else if (marker.adapter === "claude-code") {
      if (confinement.state !== "full-access") {
        verdicts.push({
          state: "unknown",
          detail: `Claude Code's Bash sandbox cannot be ruled out (${confinement.detail})`,
        });
      } else {
        verdicts.push(claudeParentAccess(marker.id, deps));
      }
    } else {
      verdicts.push({
        state: "unknown",
        detail: `${marker.adapter} records no readable access state`,
      });
    }
  }
  const sandboxedVerdict = verdicts.find((verdict) => verdict.state === "sandboxed");
  if (sandboxedVerdict) return result(sandboxedVerdict);
  const unknownVerdict = verdicts.find((verdict) => verdict.state === "unknown");
  if (unknownVerdict) return result(unknownVerdict);
  const details = verdicts.map((verdict) => verdict.detail);
  if (confinement.state === "full-access") details.push(confinement.detail);
  return result({ state: "full-access", detail: details.join("; ") });
}

/** The last line of `path` containing `needle`, reading backwards so a large
 * session log is not loaded whole. Null when absent or past `maxBytes`. */
export function lastLineContaining(
  path: string,
  needle: string,
  maxBytes = 256 * 1024 * 1024,
): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    const chunkSize = 1024 * 1024;
    const needleBytes = Buffer.from(needle);
    let position = size;
    let tail = Buffer.alloc(0);
    while (position > 0 && size - position < maxBytes) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.alloc(length);
      readSync(fd, chunk, 0, length, position);
      tail = Buffer.concat([chunk, tail]);
      const hit = tail.lastIndexOf(needleBytes);
      if (hit < 0) continue;
      const start = tail.lastIndexOf(0x0a, hit);
      if (start < 0 && position > 0) continue; // the line starts in an unread chunk
      const end = tail.indexOf(0x0a, hit);
      return tail.subarray(start + 1, end < 0 ? tail.length : end).toString("utf8");
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Candidate UTC dates (YYYY/MM/DD) for a UUIDv7 thread id: its creation day
 * and the days either side, since rollout folders use the creator's local date. */
function rolloutDays(threadId: string): string[] | null {
  const hex = threadId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return null;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  const days: string[] = [];
  for (const offset of [0, -1, 1]) {
    const date = new Date(ms + offset * 86_400_000);
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    days.push(`${y}/${m}/${d}`);
  }
  return days;
}

function codexHomes(deps: ParentAccessDeps): string[] {
  const homes: string[] = [];
  const explicit = nonEmpty(deps.env.CODEX_HOME);
  if (explicit) homes.push(explicit);
  homes.push(join(deps.homeDir, ".codex"));
  // A Windows Codex session driving a WSL checkout keeps its rollouts in the
  // Windows profile, which the guest sees under /mnt/c/Users.
  if (deps.platform === "linux" && nonEmpty(deps.env.WSL_DISTRO_NAME)) {
    for (const root of deps.windowsUserRoots()) homes.push(join(root, ".codex"));
  }
  return [...new Set(homes)];
}

function findCodexRollout(threadId: string, deps: ParentAccessDeps): string | null {
  const days = rolloutDays(threadId);
  if (!days) return null;
  const suffix = `-${threadId}.jsonl`;
  for (const home of codexHomes(deps)) {
    for (const day of days) {
      const dir = join(home, "sessions", day);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      const name = names.find((entry) => entry.startsWith("rollout-") && entry.endsWith(suffix));
      if (name) return join(dir, name);
    }
  }
  return null;
}

function codexParentAccess(threadId: string, deps: ParentAccessDeps): Verdict {
  const rollout = findCodexRollout(threadId, deps);
  if (!rollout) {
    return { state: "unknown", detail: `no Codex rollout was found for thread ${threadId}` };
  }
  const line = lastLineContaining(rollout, '"type":"turn_context"');
  if (!line) return { state: "unknown", detail: "the Codex rollout records no turn context" };
  let policyType: unknown;
  try {
    const record = JSON.parse(line) as {
      type?: unknown;
      payload?: { sandbox_policy?: { type?: unknown } };
    };
    if (record.type !== "turn_context") {
      return { state: "unknown", detail: "the Codex rollout's latest turn context is unreadable" };
    }
    policyType = record.payload?.sandbox_policy?.type;
  } catch {
    return { state: "unknown", detail: "the Codex rollout's latest turn context is unreadable" };
  }
  if (typeof policyType !== "string") {
    return { state: "unknown", detail: "the Codex turn context names no sandbox policy" };
  }
  if (policyType === "danger-full-access") {
    return {
      state: "full-access",
      detail: "the Codex parent's latest turn ran danger-full-access",
    };
  }
  return { state: "sandboxed", detail: `the Codex parent's latest turn ran ${policyType}` };
}

function findClaudeTranscript(sessionId: string, deps: ParentAccessDeps): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const configDir = nonEmpty(deps.env.CLAUDE_CONFIG_DIR) ?? join(deps.homeDir, ".claude");
  const projects = join(configDir, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function claudeParentAccess(sessionId: string, deps: ParentAccessDeps): Verdict {
  const transcript = findClaudeTranscript(sessionId, deps);
  if (!transcript) {
    return {
      state: "unknown",
      detail: `no Claude Code transcript was found for session ${sessionId}`,
    };
  }
  const line = lastLineContaining(transcript, '"permissionMode":"');
  if (!line)
    return { state: "unknown", detail: "the Claude Code transcript records no permission mode" };
  let mode: unknown;
  try {
    mode = (JSON.parse(line) as { permissionMode?: unknown }).permissionMode;
  } catch {
    return {
      state: "unknown",
      detail: "the Claude Code transcript's latest permission mode is unreadable",
    };
  }
  if (mode === "bypassPermissions") {
    return { state: "full-access", detail: "the Claude Code parent runs bypassPermissions" };
  }
  return {
    state: "sandboxed",
    detail: `the Claude Code parent runs ${typeof mode === "string" ? mode : "an unrecognized"} permission mode`,
  };
}
