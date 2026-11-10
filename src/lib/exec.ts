/**
 * Generic process-spawn helpers shared by harnery commands. Callers pass
 * `cwd` explicitly or fall back to `process.cwd()`.
 *
 * Built on `node:child_process` so it runs identically under Bun and Node.
 * harnery's published package targets Node ≥ 20, and Bun implements the same
 * module, so there's one implementation, not a runtime fork.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { windowsLaunch } from "./windows-launch.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when this process killed the child for exceeding `opts.timeout`. A
   * child that handles the signal cleanly still exits 0, so the exit code alone
   * cannot distinguish a kill from an ordinary finish. */
  timedOut?: boolean;
  /** The `code` from a spawn-level failure (`proc` "error" event), e.g.
   * "ENOENT" when the binary is absent. Absent for an ordinary process exit.
   * We collapse such failures to exitCode 127 so callers' exit-code branches
   * still fire, but a shell can legitimately exit 127 too; only this field
   * distinguishes "the binary was never there" from "the process ran and exited
   * 127". The process that knows reports it (as ADR 0044 did for `timedOut`). */
  spawnErrno?: string;
  /** The signal that ended the child, when it died by one. Reported only in
   * `processGroup` mode, where the caller needs to tell a kill from an exit. */
  signal?: NodeJS.Signals;
  /** True when the child's combined output passed `opts.maxOutputBytes` and
   * the child (or its group) was killed for it. */
  outputLimitExceeded?: boolean;
}

/** Process-group supervision for a child that may start its own children. */
export interface ProcessGroupOpts {
  /** Time between the timeout's SIGTERM and the SIGKILL that follows it.
   * Default 5000 ms. */
  graceMs?: number;
  /** After the child exits, how long to keep reading pipes that a surviving
   * descendant may still hold before settling anyway. Default 2000 ms. */
  drainMs?: number;
}

export interface ExecOpts {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string> | NodeJS.ProcessEnv;
  trim?: boolean;
  /** Return stdout and stderr exactly as received, with no trimming and no
   * trailing-newline removal. Overrides `trim`. */
  raw?: boolean;
  /** Kill the child (its group in `processGroup` mode) with SIGKILL once its
   * combined stdout and stderr pass this many bytes. */
  maxOutputBytes?: number;
  /**
   * Start the child in its own process group and stop the whole group on
   * timeout: SIGTERM, a grace period, then SIGKILL. A detached `sh` watchdog
   * enforces the same deadline outside this process, so a saturated event loop
   * cannot delay the kill. The call settles when the child exits, without
   * waiting for pipes an orphan may still hold. Live groups are also stopped
   * when this process exits or receives SIGINT, SIGTERM or SIGHUP, because a
   * child in its own group no longer gets the terminal's signals.
   *
   * On Windows, where process groups do not apply, this falls back to the
   * default single-child kill.
   */
  processGroup?: boolean | ProcessGroupOpts;
}

const DEFAULT_GRACE_MS = 5_000;
const DEFAULT_DRAIN_MS = 2_000;

// ── Live process groups, stopped when this process goes away ─────────────────

const liveGroups = new Set<number>();
const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

function killGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function onParentExit(): void {
  for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
}

function onParentSignal(signal: NodeJS.Signals): void {
  for (const pgid of liveGroups) killGroup(pgid, "SIGTERM");
  // Keep the signal's default effect when nobody else handles it: drop our
  // handlers and re-raise so this process still terminates as it would have.
  if (process.listenerCount(signal) <= 1) {
    uninstallParentHandlers();
    for (const pgid of liveGroups) killGroup(pgid, "SIGKILL");
    process.kill(process.pid, signal);
  }
}

let handlersInstalled = false;
function installParentHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", onParentExit);
  for (const signal of FORWARDED_SIGNALS) process.on(signal, onParentSignal);
}

function uninstallParentHandlers(): void {
  if (!handlersInstalled) return;
  handlersInstalled = false;
  process.off("exit", onParentExit);
  for (const signal of FORWARDED_SIGNALS) process.off(signal, onParentSignal);
}

function trackGroup(pgid: number): void {
  liveGroups.add(pgid);
  installParentHandlers();
}

function untrackGroup(pgid: number): void {
  liveGroups.delete(pgid);
  if (liveGroups.size === 0) uninstallParentHandlers();
}

/**
 * Run a shell command and return stdout/stderr/exitCode.
 *
 * `trim` defaults to true. Pass
 * `trim: false` when the consumer depends on leading whitespace. `git status
 * --porcelain` is the canonical case: the first line of ` M PATH` output gets
 * its leading space stripped by .trim(), shifting the X/Y status columns and
 * breaking any positional parser. Trailing newline still gets dropped.
 */
export function exec(cmd: string[], opts: ExecOpts = {}): Promise<ExecResult> {
  const env = (opts.env ?? { ...process.env }) as Record<string, string>;
  const launch = windowsLaunch(cmd[0] ?? "", cmd.slice(1), env);
  if ("error" in launch) {
    return Promise.resolve({
      stdout: "",
      stderr: launch.error,
      exitCode: 127,
      spawnErrno: "EINVAL",
    });
  }
  const { file, args } = launch;
  const groupOpts: ProcessGroupOpts | undefined =
    opts.processGroup && process.platform !== "win32"
      ? opts.processGroup === true
        ? {}
        : opts.processGroup
      : undefined;
  return new Promise<ExecResult>((resolveResult) => {
    const proc = spawn(file, args, {
      windowsHide: true,
      cwd: opts.cwd ?? process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...(groupOpts ? { detached: true } : {}),
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let outputLimitExceeded = false;
    const timeout = opts.timeout ?? 30_000;
    let timedOut = false;
    let settled = false;

    const signalChild = (signal?: NodeJS.Signals): void => {
      if (groupOpts && proc.pid && killGroup(proc.pid, signal ?? "SIGTERM")) return;
      try {
        proc.kill(signal);
      } catch {
        // Nothing left to kill.
      }
    };

    const collect = (sink: Buffer[], d: Buffer): void => {
      sink.push(d);
      outBytes += d.length;
      if (opts.maxOutputBytes !== undefined && outBytes > opts.maxOutputBytes && !outputLimitExceeded) {
        outputLimitExceeded = true;
        signalChild("SIGKILL");
      }
    };
    proc.stdout?.on("data", (d: Buffer) => collect(out, d));
    proc.stderr?.on("data", (d: Buffer) => collect(err, d));

    const timers: ReturnType<typeof setTimeout>[] = [];
    let watchdog: ChildProcess | undefined;
    const deadlineAt = Date.now() + timeout;

    timers.push(
      setTimeout(() => {
        timedOut = true;
        signalChild(groupOpts ? "SIGTERM" : undefined);
      }, timeout),
    );

    if (groupOpts && proc.pid) {
      const pid = proc.pid;
      const graceMs = groupOpts.graceMs ?? DEFAULT_GRACE_MS;
      trackGroup(pid);
      const killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), timeout + graceMs);
      killTimer.unref?.();
      timers.push(killTimer);
      // The out-of-process half: no event loop needed, so parent load cannot
      // delay it. Killed on settle.
      const termSec = Math.max(1, Math.ceil(timeout / 1000));
      const graceSec = Math.max(1, Math.ceil(graceMs / 1000));
      watchdog = spawn(
        "sh",
        ["-c", `sleep ${termSec}; kill -TERM -${pid} 2>/dev/null; sleep ${graceSec}; kill -KILL -${pid} 2>/dev/null`],
        { detached: true, stdio: "ignore" },
      );
      watchdog.unref();
      // The watchdog cannot flip `timedOut`; its exit means the deadline passed.
      watchdog.on("exit", () => {
        if (!settled) timedOut = true;
      });
      watchdog.on("error", () => {
        // No `sh`: the in-process timers still enforce the deadline.
      });
    }

    const finish = (
      exitCode: number,
      errOverride?: string,
      spawnErrno?: string,
      signal?: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      if (watchdog?.pid && watchdog.exitCode === null && watchdog.signalCode === null) {
        // The watchdog is detached, so it leads its own group. Killing only the
        // `sh` would leave its running `sleep` orphaned until the deadline.
        if (!killGroup(watchdog.pid, "SIGKILL")) {
          try {
            process.kill(watchdog.pid, "SIGKILL");
          } catch {
            // Watchdog already exited.
          }
        }
      }
      if (groupOpts && proc.pid) untrackGroup(proc.pid);
      // A signal death at or past the deadline is the watchdog's kill even when
      // a saturated loop processed the exit before the timer flipped `timedOut`.
      if (groupOpts && signal && Date.now() >= deadlineAt) timedOut = true;
      const stdout = Buffer.concat(out).toString("utf-8");
      const stderr = errOverride ?? Buffer.concat(err).toString("utf-8");
      const shape = (s: string): string =>
        opts.raw ? s : opts.trim !== false ? s.trim() : s.replace(/\n$/, "");
      resolveResult({
        stdout: shape(stdout),
        stderr: shape(stderr),
        exitCode,
        ...(timedOut ? { timedOut: true } : {}),
        ...(spawnErrno ? { spawnErrno } : {}),
        ...(groupOpts && signal ? { signal } : {}),
        ...(outputLimitExceeded ? { outputLimitExceeded: true } : {}),
      });
    };

    // ENOENT (binary not found) and similar spawn failures surface here rather
    // than throwing: resolve with 127 + the message so callers' exitCode
    // branches handle it instead of crashing on an unhandled rejection. The
    // errno (e.g. "ENOENT") is carried through so a real missing binary is
    // distinguishable from a shell that merely exited 127.
    proc.on("error", (e: Error) => finish(127, e.message, (e as NodeJS.ErrnoException).code));
    proc.on("close", (code, signal) => finish(code ?? 1, undefined, undefined, signal));
    if (groupOpts) {
      // A descendant that outlives the child can hold the pipes open; settle
      // on exit after a short drain instead of waiting for "close".
      proc.on("exit", (code, signal) => {
        const drain = setTimeout(() => {
          proc.stdout?.destroy();
          proc.stderr?.destroy();
          finish(code ?? 1, undefined, undefined, signal);
        }, groupOpts.drainMs ?? DEFAULT_DRAIN_MS);
        drain.unref?.();
        timers.push(drain);
      });
    }
  });
}
