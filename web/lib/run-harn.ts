/**
 * Runs this project's harn CLI from a server component or route, so the
 * dashboard and the CLI share one implementation of each report.
 *
 * `harnCommand` picks the launcher: `bin/harn` is a POSIX shell script that
 * Windows cannot start without a shell, so Windows runs `bin/harn.mjs`.
 */

import { spawn } from "node:child_process";
import { coordRoot } from "./coord-reader";
import { harnChildEnv, harnCommand } from "./harn-command";

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

export function runHarn(args: string[], opts: { timeoutMs?: number } = {}): Promise<HarnResult> {
  const root = coordRoot();
  const harn = harnCommand(root, args);
  return new Promise((resolve) => {
    const proc = spawn(harn.command, harn.args, {
      cwd: root,
      env: harnChildEnv(root),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stderr += `harn ${args[0] ?? ""} did not finish in ${Math.round(opts.timeoutMs! / 1000)} seconds`;
          proc.kill();
        }, opts.timeoutMs)
      : undefined;
    proc.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, stdout, stderr, exitCode: code, timedOut });
    });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}${err.message}`, exitCode: null, timedOut });
    });
  });
}
