/**
 * Runs this project's Harnery CLI (`harn`, or `agent-coord` for the coord
 * helpers) from a server component or route, so the dashboard and the CLI
 * share one implementation of each report and write. Every dashboard spawn
 * goes through here: one result shape, one timeout, one stdin path.
 *
 * `harnCommand` picks the launcher: `bin/harn` is a POSIX shell script that
 * Windows cannot start without a shell, so Windows runs `bin/harn.mjs`.
 */

import { spawn } from "node:child_process";
import { coordRoot } from "./coord-reader";
import { type HarneryExecutable, harnChildEnv, harnCommand } from "./harn-command";

export { harnChildEnv };

export interface HarnResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The process exit code; null when it was killed or never started. */
  exitCode: number | null;
  /** True when `timeoutMs` ran out and the process was killed. */
  timedOut: boolean;
}

/** The write helpers' name for the same result. */
export type HelperResult = HarnResult;

/** A CLI call that hangs must not hold a request (or a page render) forever. */
export const DEFAULT_HARN_TIMEOUT_MS = 60_000;

export interface RunHarnOptions {
  /** Which bundled executable to start. Defaults to `harn`. */
  executable?: HarneryExecutable;
  /** Written to the child's stdin, which is then closed (keeps secrets out of argv). */
  stdin?: string;
  /** Kill the child after this long. Defaults to `DEFAULT_HARN_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export function runHarn(args: string[], opts: RunHarnOptions = {}): Promise<HarnResult> {
  const root = coordRoot();
  const executable = opts.executable ?? "harn";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HARN_TIMEOUT_MS;
  const harn = harnCommand(root, args, { executable });
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const finish = (result: Omit<HarnResult, "stdout" | "stderr" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    const proc = spawn(harn.command, harn.args, {
      cwd: root,
      env: harnChildEnv(root),
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `${executable} ${args[0] ?? ""} did not finish in ${Math.round(timeoutMs / 1000)} seconds`;
      proc.kill();
    }, timeoutMs);
    proc.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("close", (code) => {
      finish({ ok: code === 0 && !timedOut, exitCode: code });
    });
    proc.on("error", (err) => {
      stderr += err.message;
      finish({ ok: false, exitCode: null });
    });
    // A child that exits (or never starts) before reading its input makes the
    // write fail with EPIPE; unhandled, that error would crash the server.
    proc.stdin.on("error", () => {});
    if (opts.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
      proc.stdin.end();
    }
  });
}
