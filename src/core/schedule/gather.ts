/**
 * Run a scheduled job's gather commands: each one a plain subprocess with
 * literal arguments and no shell, from the checkout root, with a small base
 * environment plus only the variable names the command lists. Output goes to
 * `gather/<name>.txt` in the run folder, capped; one deadline covers every
 * command, and a command still running at it is killed with its whole process
 * group. Never throws for a command's own failure; each ends `ok`, `finding`
 * or `error` as `ScheduleGatherResult` describes.
 */

import { type ChildProcess, spawn as nodeSpawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { windowsLaunch } from "../../lib/windows-launch.ts";
import { stateDirMode, stateFileMode } from "../storage/modes.ts";
import {
  SCHEDULE_CHILD_ENV,
  SCHEDULE_GATHER_OUTPUT_CAP_BYTES,
  type ScheduleGatherCommand,
  type ScheduleGatherResult,
} from "./job-types.ts";
import { scheduleGatherOutputPath, scheduleGatherOutputRelativePath } from "./paths.ts";

/**
 * Variables every scheduled child may receive by name: enough to find
 * programs, the home folder, the locale and temporary folders on POSIX and
 * Windows. No credential lives in any of them.
 */
export const SCHEDULE_BASE_ENV_NAMES: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SystemRoot",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
]);

/** How long to wait for a finished command's pipes before moving on. */
const DRAIN_MS = 2_000;

export interface ScheduleGatherOptions {
  commands: readonly ScheduleGatherCommand[];
  /** The checkout root; every command runs from here. */
  coordRoot: string;
  /** The run folder; output goes to `gather/<name>.txt` inside it. */
  runDir: string;
  /** Epoch milliseconds. One deadline for every command together. */
  deadlineAtMs: number;
  /** The launching environment; only named variables are read from it. */
  env: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  spawn?: typeof nodeSpawn;
  /** Test override for the per-command output cap. */
  outputCapBytes?: number;
  /** Test override for `process.platform`. */
  platform?: NodeJS.Platform;
}

function lookup(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const exact = env[name];
  if (exact !== undefined || platform !== "win32") return exact;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** The environment one gather command receives. */
export function scheduleGatherEnv(
  command: Pick<ScheduleGatherCommand, "env">,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...SCHEDULE_BASE_ENV_NAMES, ...(command.env ?? [])]) {
    const value = lookup(env, name, platform);
    if (value !== undefined) out[name] = value;
  }
  out[SCHEDULE_CHILD_ENV] = "1";
  return out;
}

function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  const pid = child.pid;
  if (!pid) return;
  if (platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function openOutput(path: string): number {
  mkdirSync(dirname(path), { recursive: true, mode: stateDirMode() });
  const fd = openSync(path, "w", stateFileMode());
  try {
    chmodSync(path, stateFileMode());
  } catch {
    // Windows does not expose POSIX modes.
  }
  return fd;
}

interface Outcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnErrno?: string;
  timedOut: boolean;
  truncated: boolean;
}

function runOne(
  command: ScheduleGatherCommand,
  opts: ScheduleGatherOptions,
  fd: number,
  cap: number,
  platform: NodeJS.Platform,
): Promise<Outcome> {
  const env = scheduleGatherEnv(command, opts.env, platform);
  const [program = "", ...args] = command.argv;
  const launch = windowsLaunch(program, args, env, platform);
  if ("error" in launch) {
    writeSync(fd, `${launch.error}\n`);
    return Promise.resolve({
      exitCode: null,
      signal: null,
      spawnErrno: "EINVAL",
      timedOut: false,
      truncated: false,
    });
  }
  const spawnFn = opts.spawn ?? nodeSpawn;
  const now = opts.now ?? Date.now;
  return new Promise<Outcome>((done) => {
    let written = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let child: ChildProcess;
    const finish = (o: Omit<Outcome, "timedOut" | "truncated">) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      done({ ...o, timedOut, truncated });
    };
    try {
      child = spawnFn(launch.file, launch.args, {
        cwd: resolve(opts.coordRoot),
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: platform !== "win32",
        shell: false,
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      finish({
        exitCode: null,
        signal: null,
        spawnErrno: typeof code === "string" ? code : "EINVAL",
      });
      return;
    }
    const onData = (chunk: Buffer) => {
      if (truncated) return;
      const room = cap - written;
      if (chunk.length > room) {
        if (room > 0) writeSync(fd, chunk, 0, room);
        written = cap;
        truncated = true;
        return;
      }
      writeSync(fd, chunk);
      written += chunk.length;
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (exited) return;
      finish({ exitCode: null, signal: null, spawnErrno: error.code ?? "EINVAL" });
    });
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      // A grandchild may still hold the pipes; wait briefly, then stop the group.
      const drain = setTimeout(() => {
        killTree(child, platform);
        finish({ exitCode: code, signal });
      }, DRAIN_MS);
      timers.push(drain);
    });
    child.on("close", () => {
      const e = exited;
      if (!e) return;
      if (platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group is already empty.
        }
      }
      finish({ exitCode: e.code, signal: e.signal });
    });
    const left = Math.max(0, opts.deadlineAtMs - now());
    const deadline = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      killTree(child, platform);
    }, left);
    timers.push(deadline);
  });
}

function describe(
  command: ScheduleGatherCommand,
  o: Outcome,
  cap: number,
): {
  state: ScheduleGatherResult["state"];
  error?: string;
} {
  if (o.spawnErrno) return { state: "error", error: `could not start: ${o.spawnErrno}` };
  if (o.timedOut) return { state: "error", error: "timed out at the job deadline and was killed" };
  if (o.truncated) {
    return { state: "error", error: `output passed the ${cap}-byte cap and was truncated` };
  }
  if (o.exitCode === null) {
    return { state: "error", error: `killed by signal ${o.signal ?? "unknown"}` };
  }
  if (o.exitCode === 0) return { state: "ok" };
  if (command.finding_exit_codes?.includes(o.exitCode)) return { state: "finding" };
  return { state: "error", error: `unexpected exit code ${o.exitCode}` };
}

/** Run every gather command in order under one deadline. */
export async function runScheduleGather(
  opts: ScheduleGatherOptions,
): Promise<ScheduleGatherResult[]> {
  const now = opts.now ?? Date.now;
  const cap = opts.outputCapBytes ?? SCHEDULE_GATHER_OUTPUT_CAP_BYTES;
  const platform = opts.platform ?? process.platform;
  const results: ScheduleGatherResult[] = [];
  for (const command of opts.commands) {
    const output_file = scheduleGatherOutputRelativePath(command.name);
    const fd = openOutput(scheduleGatherOutputPath(opts.runDir, command.name));
    try {
      if (now() >= opts.deadlineAtMs) {
        results.push({
          name: command.name,
          state: "error",
          exit_code: null,
          duration_ms: 0,
          truncated: false,
          error: "deadline passed before start",
          output_file,
        });
        continue;
      }
      const t0 = now();
      const outcome = await runOne(command, opts, fd, cap, platform);
      const verdict = describe(command, outcome, cap);
      results.push({
        name: command.name,
        state: verdict.state,
        exit_code: outcome.exitCode,
        duration_ms: Math.max(0, now() - t0),
        truncated: outcome.truncated,
        ...(verdict.error ? { error: verdict.error } : {}),
        output_file,
      });
    } finally {
      closeSync(fd);
    }
  }
  return results;
}
