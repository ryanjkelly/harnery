/**
 * Generic process-spawn helpers shared by harnery commands. Callers pass
 * `cwd` explicitly or fall back to `process.cwd()`.
 *
 * Built on `node:child_process` so it runs identically under Bun and Node.
 * harnery's published package targets Node ≥ 20, and Bun implements the same
 * module, so there's one implementation, not a runtime fork.
 */

import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOpts {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  trim?: boolean;
}

/**
 * Run a shell command and return stdout/stderr/exitCode.
 *
 * `trim` defaults to true (back-compat with every existing caller). Pass
 * `trim: false` when the consumer depends on leading whitespace. `git status
 * --porcelain` is the canonical case: the first line of ` M PATH` output gets
 * its leading space stripped by .trim(), shifting the X/Y status columns and
 * breaking any positional parser. Trailing newline still gets dropped.
 */
export function exec(cmd: string[], opts: ExecOpts = {}): Promise<ExecResult> {
  const [file, ...args] = cmd;
  return new Promise<ExecResult>((resolveResult) => {
    const proc = spawn(file, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout?.on("data", (d: Buffer) => out.push(d));
    proc.stderr?.on("data", (d: Buffer) => err.push(d));

    const timeout = opts.timeout ?? 30_000;
    const timer = setTimeout(() => proc.kill(), timeout);

    const finish = (exitCode: number, errOverride?: string): void => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf-8");
      const stderr = errOverride ?? Buffer.concat(err).toString("utf-8");
      const shouldTrim = opts.trim !== false;
      resolveResult({
        stdout: shouldTrim ? stdout.trim() : stdout.replace(/\n$/, ""),
        stderr: shouldTrim ? stderr.trim() : stderr.replace(/\n$/, ""),
        exitCode,
      });
    };

    // ENOENT (binary not found) and similar spawn failures surface here rather
    // than throwing: resolve with 127 + the message so callers' exitCode
    // branches handle it instead of crashing on an unhandled rejection.
    proc.on("error", (e: Error) => finish(127, e.message));
    proc.on("close", (code) => finish(code ?? 1));
  });
}

/** Run a shell command via /bin/sh -c (for pipes, redirects, etc.) */
export async function sh(command: string, opts: Omit<ExecOpts, "trim"> = {}): Promise<ExecResult> {
  return exec(["sh", "-c", command], opts);
}
