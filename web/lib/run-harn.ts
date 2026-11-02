/**
 * Runs this project's harn CLI from a server component or route, so the
 * dashboard and the CLI share one implementation of each report.
 *
 * The runtime runs `bin/harn.mjs` directly: `bin/harn` is a POSIX shell
 * script that Windows cannot start without a shell.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { coordRoot } from "./coord-reader";

export interface HarnResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The dashboard server's environment for a child harn. NODE_OPTIONS is
 * dropped: the server runs with `--import=./server-preload.mjs`, relative to
 * web/, which a child started in the project root cannot find.
 */
export function harnChildEnv(
  root: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, HARNERY_COORD_ROOT_OVERRIDE: root };
  delete env.NODE_OPTIONS;
  return env;
}

export function runHarn(args: string[], opts: { timeoutMs?: number } = {}): Promise<HarnResult> {
  const root = coordRoot();
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(root, "harnery", "bin", "harn.mjs"), ...args], {
      cwd: root,
      env: harnChildEnv(root),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => {
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
      resolve({ ok: code === 0, stdout, stderr });
    });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}${err.message}` });
    });
  });
}
