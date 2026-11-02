/**
 * Project self-update engine (ADR 0229).
 *
 * `autoUpdateTick` is the hot path every prompt, session start, and host CLI
 * command calls: one stat of the throttle stamp when nothing is due. When the
 * stamp is stale it claims the stamp and launches a detached
 * `<harn> autoupdate run --background`, which decides with `checkForUpdate`
 * and, only when needed, runs the host's configured steps under a lock.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { readAutoUpdateConfig, resolveBinName } from "../config.ts";
import { fingerprint } from "./fingerprint.ts";
import {
  changedFiles,
  contains,
  defaultGitRunner,
  type GitRunner,
  head,
  lsRemote,
  upstream,
} from "./git.ts";
import {
  acquireRunLock,
  addNotice,
  autoUpdateDir,
  autoUpdateLogPath,
  autoUpdateStampPath,
  inspectLock,
  type LockInspection,
  type LockOwner,
  mutateAutoUpdateState,
  readAutoUpdateState,
} from "./state.ts";
import {
  AUTOUPDATE_DEFAULTS,
  AUTOUPDATE_FILES,
  type AutoUpdateConfig,
  type AutoUpdateNotice,
  type AutoUpdateState,
  type CheckDecision,
  EXIT_NEEDS_PERSON,
  NOTICE_PREFIX,
  type NoticeKind,
  type RunOutcome,
  type RunRecord,
  type StepRecord,
  type TickResult,
} from "./types.ts";

/** Set on the detached runner and every step so nested CLI calls never tick. */
export const AUTOUPDATE_CHILD_ENV = "HARNERY_AUTOUPDATE_CHILD";

const MINUTE_MS = 60_000;
const DAY_MS = AUTOUPDATE_DEFAULTS.dailyHours * 60 * MINUTE_MS;
const LOG_ROTATE_BYTES = 256 * 1024;
const LOG_KEEP_BYTES = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 5 * MINUTE_MS;
const KILL_GRACE_MS = 5_000;

export interface StepRunResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  ms: number;
}

export type StepRunner = (
  argv: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    onChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
  },
) => Promise<StepRunResult>;

export interface AutoUpdateDeps {
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  readConfig?: (coordRoot: string) => AutoUpdateConfig | null;
  git?: GitRunner;
  /** Launch the detached runner (tick). */
  spawnRunner?: (coordRoot: string) => void;
  runStep?: StepRunner;
  /** Expired-artifact cleanup; best effort. */
  runCleanup?: (coordRoot: string) => void;
  binName?: string;
}

interface Resolved {
  now: () => number;
  env: NodeJS.ProcessEnv;
  readConfig: (coordRoot: string) => AutoUpdateConfig | null;
  git: GitRunner;
}

function resolveDeps(deps: AutoUpdateDeps): Resolved {
  return {
    now: deps.now ?? Date.now,
    env: deps.env ?? process.env,
    readConfig: deps.readConfig ?? readAutoUpdateConfig,
    git: deps.git ?? defaultGitRunner,
  };
}

// ------------------------------------------------------------------ helpers

/** The CLI entry the detached runner executes with `process.execPath`. */
export function harnCliEntry(): string {
  const ext = extname(fileURLToPath(import.meta.url)) || ".js";
  const entry = fileURLToPath(new URL(`../../cli${ext}`, import.meta.url));
  if (existsSync(entry)) return entry;
  return fileURLToPath(new URL("../../../bin/harn.mjs", import.meta.url));
}

/** Set the throttle stamp's mtime (creating it), which is all the tick reads. */
export function setStamp(coordRoot: string, atMs: number): void {
  const path = autoUpdateStampPath(coordRoot);
  if (!existsSync(path)) {
    mkdirSync(autoUpdateDir(coordRoot), { recursive: true });
    writeFileSync(path, "");
  }
  const at = atMs / 1000;
  utimesSync(path, at, at);
}

function stampMtime(coordRoot: string): number | null {
  try {
    return statSync(autoUpdateStampPath(coordRoot)).mtimeMs;
  } catch {
    return null;
  }
}

/** Keep the log bounded: past 256 KB, keep only its last 64 KB. */
export function rotateLog(path: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= LOG_ROTATE_BYTES) return;
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(LOG_KEEP_BYTES);
  try {
    readSync(fd, buffer, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES);
  } finally {
    closeSync(fd);
  }
  const tmp = `${path}.rotating`;
  writeFileSync(tmp, buffer);
  renameSync(tmp, path);
}

function appendLog(coordRoot: string, text: string): void {
  try {
    const path = autoUpdateLogPath(coordRoot);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, text);
  } catch {
    // Logging is best effort.
  }
}

function logLine(coordRoot: string, now: number, line: string): void {
  appendLog(coordRoot, `${new Date(now).toISOString()} ${line}\n`);
}

function isChild(env: NodeJS.ProcessEnv): boolean {
  return env[AUTOUPDATE_CHILD_ENV] === "1";
}

/**
 * Git sets these for the hooks it runs (`GIT_INDEX_FILE` during a commit,
 * `GIT_EXEC_PATH` for every hook). A self-update launched from a hook would
 * run the project's update steps, typically a pull, in the middle of a commit
 * or push, or write its state into a hook's temporary snapshot as the hook
 * deletes it, so activity inside a hook never fires one.
 */
export const GIT_HOOK_ENV = ["GIT_INDEX_FILE", "GIT_EXEC_PATH"] as const;

function insideGitHook(env: NodeJS.ProcessEnv): boolean {
  return GIT_HOOK_ENV.some((name) => Boolean(env[name]));
}

function dailyDue(cfg: AutoUpdateConfig, state: AutoUpdateState, now: number): boolean {
  if (cfg.dailySteps.length === 0) return false;
  if (!state.dailyAt) return true;
  const at = Date.parse(state.dailyAt);
  return !Number.isFinite(at) || now - at >= DAY_MS;
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

const INSTRUCTION_PREFIXES = [".agents/", ".claude/skills/", ".claude/rules/", ".cursor/rules/"];
const HOOK_PATHS = new Set([
  ".claude/settings.json",
  ".codex/hooks.json",
  ".codex/config.toml",
  ".cursor/hooks.json",
]);

export function isInstructionPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (base === "AGENTS.md" || base === "CLAUDE.md" || base === "SKILL.md") return true;
  if (base.endsWith(".mdc")) return true;
  return INSTRUCTION_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isHookConfigPath(path: string): boolean {
  return HOOK_PATHS.has(path.replace(/\\/g, "/"));
}

/** `harnery-notice:` lines in step output. */
export function parseNoticeLines(output: string): string[] {
  const texts: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!line.startsWith(NOTICE_PREFIX)) continue;
    const text = line.slice(NOTICE_PREFIX.length).trim();
    if (text) texts.push(text);
  }
  return texts;
}

// ------------------------------------------------------------------ tick

function defaultSpawnRunner(coordRoot: string): void {
  const root = resolve(coordRoot);
  const logPath = autoUpdateLogPath(root);
  mkdirSync(dirname(logPath), { recursive: true });
  rotateLog(logPath);
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [harnCliEntry(), "autoupdate", "run", "--background"], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...process.env,
        [AUTOUPDATE_CHILD_ENV]: "1",
        HARNERY_COORD_ROOT_OVERRIDE: root,
      },
    });
    child.once("error", () => {
      logLine(root, Date.now(), "runner could not start");
    });
    child.unref();
  } finally {
    closeSync(fd);
  }
}

/**
 * Activity hook. Never throws. When throttled it reads the config and stats
 * one file; it runs no Git and parses no state.
 */
export function autoUpdateTick(coordRoot: string, deps: AutoUpdateDeps = {}): TickResult {
  try {
    const d = resolveDeps(deps);
    if (isChild(d.env)) return { action: "disabled", detail: "inside an auto-update run" };
    if (insideGitHook(d.env)) return { action: "disabled", detail: "inside a Git hook" };
    const cfg = d.readConfig(coordRoot);
    if (!cfg?.enabled) return { action: "disabled" };
    const now = d.now();
    const mtime = stampMtime(coordRoot);
    if (mtime !== null && now - mtime < cfg.checkMinutes * MINUTE_MS) {
      return { action: "throttled" };
    }
    const lock = inspectLock(coordRoot, cfg, now);
    if (lock.held && !lock.stale) {
      return { action: "locked", detail: lock.owner ? `pid ${lock.owner.pid}` : undefined };
    }
    // Claim before launching so concurrent ticks see a fresh stamp.
    setStamp(coordRoot, now);
    (deps.spawnRunner ?? defaultSpawnRunner)(coordRoot);
    return { action: "launched" };
  } catch (err) {
    return { action: "error", detail: (err as Error)?.message ?? String(err) };
  }
}

// ------------------------------------------------------------------ check

export function checkForUpdate(
  coordRoot: string,
  cfg: AutoUpdateConfig,
  state: AutoUpdateState,
  deps: AutoUpdateDeps & { force?: boolean } = {},
): CheckDecision {
  const d = resolveDeps(deps);
  const now = d.now();
  const root = resolve(coordRoot);
  const fp = fingerprint(cfg.watch, root, d.env);
  const currentHead = head(root, d.git);
  const base = {
    head: currentHead,
    upstream: null as string | null,
    remoteSha: null as string | null,
    fingerprint: fp,
    dailyOnly: false,
  };
  if (deps.force) return { ...base, needed: true, reason: "forced" };
  const drift = !state.converged || state.converged.fingerprint !== fp;
  const up = upstream(root, d.git);
  if (!up) {
    return drift
      ? { ...base, needed: true, reason: "drift", detail: "watched paths changed" }
      : { ...base, needed: false, reason: "no-upstream" };
  }
  const withUp = { ...base, upstream: up.display };
  const remoteSha = lsRemote(root, up.remote, up.branch, d.git);
  if (!remoteSha) {
    return { ...withUp, needed: false, reason: "offline", detail: `could not reach ${up.remote}` };
  }
  const withRemote = { ...withUp, remoteSha };
  if (!contains(root, remoteSha, d.git)) {
    return {
      ...withRemote,
      needed: true,
      reason: "behind",
      detail: `${up.display} at ${short(remoteSha)}`,
    };
  }
  if (drift)
    return { ...withRemote, needed: true, reason: "drift", detail: "watched paths changed" };
  const last = state.lastRun;
  if (last?.outcome === "failed") {
    const finished = Date.parse(last.finishedAt);
    if (
      !Number.isFinite(finished) ||
      now - finished >= AUTOUPDATE_DEFAULTS.failureBackoffMinutes * MINUTE_MS
    ) {
      return { ...withRemote, needed: true, reason: "retry" };
    }
  }
  if (dailyDue(cfg, state, now)) {
    return { ...withRemote, needed: true, reason: "daily", dailyOnly: true };
  }
  return { ...withRemote, needed: false, reason: "current" };
}

// ------------------------------------------------------------------ run

/**
 * Resolve a step's argv for the current platform. On Windows a bare command
 * name such as `bun` or `git` is looked up on PATH with PATHEXT, because
 * spawning without a shell does not try `.cmd` shims; a `.cmd` or `.bat`
 * match runs through `cmd.exe`. Elsewhere the argv is used as is.
 */
export function resolveStepCommand(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): { cmd: string; args: string[]; verbatim: boolean } {
  if (platform !== "win32" || /[\\/]/.test(cmd) || extname(cmd) !== "") {
    return { cmd, args, verbatim: false };
  }
  const pathVar = env.Path ?? env.PATH ?? "";
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of pathVar.split(";").filter(Boolean)) {
    for (const ext of exts) {
      const candidate = win32.join(dir, cmd + ext.toLowerCase());
      if (!exists(candidate)) continue;
      if (/^\.(cmd|bat)$/i.test(ext)) {
        const quote = (s: string) => (/[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
        const line = [candidate, ...args].map(quote).join(" ");
        return {
          cmd: env.ComSpec ?? "cmd.exe",
          args: ["/d", "/s", "/c", `"${line}"`],
          verbatim: true,
        };
      }
      return { cmd: candidate, args, verbatim: false };
    }
  }
  return { cmd, args, verbatim: false };
}
export const defaultStepRunner: StepRunner = (argv, opts) =>
  new Promise((resolveRun) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ exitCode, timedOut, output, ms: Date.now() - started });
    };
    const [rawCmd, ...rawArgs] = argv;
    if (!rawCmd) {
      finish(null);
      return;
    }
    const { cmd, args, verbatim } = resolveStepCommand(rawCmd, rawArgs, opts.env ?? process.env);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (stream: "stdout" | "stderr") => (data: Buffer) => {
      const chunk = data.toString("utf8");
      output += chunk;
      opts.onChunk?.(chunk, stream);
    };
    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref();
    }, opts.timeoutMs);
    child.once("error", (err) => {
      output += `${err.message}\n`;
      finish(null);
    });
    child.once("exit", (code) => {
      // A grandchild that keeps the pipes open must not hold the run.
      setTimeout(() => finish(timedOut ? null : code), 2_000).unref();
    });
    child.once("close", (code) => finish(timedOut ? null : code));
  });

function defaultCleanup(coordRoot: string): void {
  spawnSync(process.execPath, [harnCliEntry(), "artifacts", "clean", "--yes"], {
    cwd: coordRoot,
    env: { ...process.env, [AUTOUPDATE_CHILD_ENV]: "1", HARNERY_COORD_ROOT_OVERRIDE: coordRoot },
    stdio: "ignore",
    timeout: CLEANUP_TIMEOUT_MS,
    windowsHide: true,
  });
}

export interface RunAutoUpdateOptions {
  force?: boolean;
  /** Detached runner: output goes to the log only. */
  background?: boolean;
  /** Foreground streaming of step output (in addition to the log). */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  deps?: AutoUpdateDeps;
}

export interface RunAutoUpdateResult {
  outcome: RunOutcome;
  decision: CheckDecision | null;
  record: RunRecord | null;
  /** Notices recorded by this run. */
  notices: AutoUpdateNotice[];
  /** Holder of the lock when `skipped-locked`. */
  lockOwner?: LockOwner | null;
}

export async function runAutoUpdate(
  coordRootRaw: string,
  opts: RunAutoUpdateOptions = {},
): Promise<RunAutoUpdateResult> {
  const deps = opts.deps ?? {};
  const d = resolveDeps(deps);
  const root = resolve(coordRootRaw);
  const cfg = d.readConfig(root);
  if (!cfg || (!cfg.enabled && !opts.force)) {
    return { outcome: "current", decision: null, record: null, notices: [] };
  }
  const startedMs = d.now();
  const lock = acquireRunLock(root, cfg, startedMs);
  if (!lock.acquired) {
    return {
      outcome: "skipped-locked",
      decision: null,
      record: null,
      notices: [],
      lockOwner: lock.owner,
    };
  }
  const binName = deps.binName ?? resolveBinName(root);
  const runStep = deps.runStep ?? defaultStepRunner;
  const stepEnv: NodeJS.ProcessEnv = { ...d.env, [AUTOUPDATE_CHILD_ENV]: "1" };
  const pending: Array<{ kind: NoticeKind; text: string }> = [];
  const steps: StepRecord[] = [];
  const startedAt = new Date(startedMs).toISOString();
  let decision: CheckDecision | null = null;
  let outcome: RunOutcome = "current";
  let fromHead: string | null = null;
  let toHead: string | null = null;
  let error: string | undefined;
  let convergedUpdate: AutoUpdateState["converged"] | undefined;
  let dailyAt: string | undefined;
  let backoff = false;

  const say = (line: string) => {
    logLine(root, d.now(), line);
    opts.onOutput?.(`${line}\n`, "stderr");
  };

  // Returns "ok" | "blocked" | "failed".
  const runPhase = async (
    list: string[][],
    label: string,
  ): Promise<"ok" | "blocked" | "failed"> => {
    for (const argv of list) {
      const shown = argv.join(" ");
      say(`${label} start: ${shown}`);
      const result = await runStep(argv, {
        cwd: root,
        timeoutMs: cfg.timeoutMinutes * MINUTE_MS,
        env: stepEnv,
        onChunk: (chunk, stream) => {
          appendLog(root, chunk);
          opts.onOutput?.(chunk, stream);
        },
      });
      steps.push({
        argv,
        exitCode: result.exitCode,
        ms: result.ms,
        ...(result.timedOut ? { timedOut: true } : {}),
      });
      const needsPerson = result.exitCode === EXIT_NEEDS_PERSON;
      for (const text of parseNoticeLines(result.output)) {
        pending.push({ kind: needsPerson ? "person" : "info", text });
      }
      say(
        `${label} exit ${result.exitCode ?? "none"}${result.timedOut ? " (timed out)" : ""} in ${result.ms}ms: ${shown}`,
      );
      if (needsPerson) return "blocked";
      if (result.exitCode !== 0) {
        const how = result.timedOut
          ? `timed out after ${cfg.timeoutMinutes} min`
          : `exit ${result.exitCode ?? "none"}`;
        pending.push({
          kind: "failure",
          text: `Auto-update step \`${shown}\` failed (${how}); see .harnery/logs/${AUTOUPDATE_FILES.log} or run \`${binName} autoupdate run\`.`,
        });
        return "failed";
      }
    }
    return "ok";
  };

  try {
    const state = readAutoUpdateState(root);
    decision = checkForUpdate(root, cfg, state, { ...deps, force: opts.force });
    fromHead = decision.head;
    toHead = decision.head;
    say(`check: ${decision.reason}${decision.detail ? ` (${decision.detail})` : ""}`);
    if (!decision.needed) {
      outcome = decision.reason === "offline" ? "offline" : "current";
    } else {
      let phase: "ok" | "blocked" | "failed" = "ok";
      if (!decision.dailyOnly) phase = await runPhase(cfg.steps, "step");
      if (phase === "ok") {
        toHead = head(root, d.git);
        if (fromHead && toHead && fromHead !== toHead) {
          const changed = changedFiles(root, fromHead, toHead, d.git);
          const moved = `This checkout updated ${short(fromHead)}→${short(toHead)}.`;
          if (changed.some(isInstructionPath)) {
            pending.push({
              kind: "instructions",
              text: `${moved} Re-read AGENTS.md and any skill you are using before continuing.`,
            });
          }
          if (changed.some(isHookConfigPath)) {
            pending.push({
              kind: "hooks",
              text: `${moved} Hook settings changed; start a new session so they load.`,
            });
          }
        }
        convergedUpdate = {
          head: toHead ?? "",
          remoteSha: decision.remoteSha,
          fingerprint: fingerprint(cfg.watch, root, d.env),
          at: new Date(d.now()).toISOString(),
        };
        if (dailyDue(cfg, state, d.now())) {
          const daily = await runPhase(cfg.dailySteps, "daily");
          if (daily !== "failed") dailyAt = new Date(d.now()).toISOString();
          phase = daily;
        }
      }
      outcome =
        phase === "blocked"
          ? "blocked"
          : phase === "failed"
            ? "failed"
            : decision.dailyOnly
              ? "current"
              : "updated";
      backoff = phase === "failed";
    }
  } catch (err) {
    outcome = "failed";
    backoff = true;
    error = (err as Error)?.message ?? String(err);
    say(`error: ${error}`);
  }

  const notices: AutoUpdateNotice[] = [];
  const finishedMs = d.now();
  const record: RunRecord = {
    startedAt,
    finishedAt: new Date(finishedMs).toISOString(),
    outcome,
    reason: decision?.reason ?? "forced",
    fromHead,
    toHead,
    steps,
    ...(error ? { error } : {}),
  };
  let cleanupAt: string | undefined;
  try {
    const priorState = readAutoUpdateState(root);
    const lastCleanup = priorState.cleanupAt ? Date.parse(priorState.cleanupAt) : Number.NaN;
    const cleanupDue =
      cfg.cleanup &&
      (outcome === "updated" || outcome === "current") &&
      (!Number.isFinite(lastCleanup) || finishedMs - lastCleanup >= DAY_MS);
    if (cleanupDue) {
      try {
        (deps.runCleanup ?? defaultCleanup)(root);
      } catch {
        // Cleanup is best effort.
      }
      cleanupAt = new Date(d.now()).toISOString();
    }
    mutateAutoUpdateState(root, (s) => {
      s.lastRun = record;
      if (convergedUpdate) s.converged = convergedUpdate;
      if (dailyAt) s.dailyAt = dailyAt;
      if (cleanupAt) s.cleanupAt = cleanupAt;
      // A run that succeeded resolves earlier failures and person requests,
      // so sessions that start later are not told about a fixed problem.
      if (outcome === "updated" || outcome === "current") {
        s.notices = s.notices.filter((n) => n.kind !== "failure" && n.kind !== "person");
      }
      for (const n of pending) notices.push(addNotice(s, n.kind, n.text, finishedMs));
    });
    // A failed run pushes the stamp forward so the tick stays one stat while backing off.
    const backoffMs = AUTOUPDATE_DEFAULTS.failureBackoffMinutes * MINUTE_MS;
    setStamp(root, backoff ? finishedMs + backoffMs - cfg.checkMinutes * MINUTE_MS : finishedMs);
    say(`run ${outcome} (${record.reason})`);
  } finally {
    lock.release();
  }
  return { outcome, decision, record, notices };
}

// ------------------------------------------------------------------ status

export interface AutoUpdateStatus {
  config: AutoUpdateConfig | null;
  state: AutoUpdateState;
  /** Milliseconds since the throttle stamp (negative while backing off); null when never checked. */
  stampAge: number | null;
  /** Milliseconds until a tick would launch a check; 0 when due. */
  nextCheckMs: number | null;
  locked: LockInspection;
}

export function autoUpdateStatus(
  coordRootRaw: string,
  deps: AutoUpdateDeps = {},
): AutoUpdateStatus {
  const d = resolveDeps(deps);
  const root = resolve(coordRootRaw);
  const config = d.readConfig(root);
  const now = d.now();
  const mtime = stampMtime(root);
  const stampAge = mtime === null ? null : now - mtime;
  const checkMs = (config?.checkMinutes ?? AUTOUPDATE_DEFAULTS.checkMinutes) * MINUTE_MS;
  const nextCheckMs = stampAge === null ? 0 : Math.max(0, checkMs - stampAge);
  const locked = inspectLock(
    root,
    config ?? { timeoutMinutes: AUTOUPDATE_DEFAULTS.timeoutMinutes, steps: [], dailySteps: [] },
    now,
  );
  return { config, state: readAutoUpdateState(root), stampAge, nextCheckMs, locked };
}
