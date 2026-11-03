/**
 * Process primitives for the op toolkit, on `node:*` APIs so the published
 * package runs under Node as well as Bun.
 *
 * Stdin matters for `op`: the Windows `op.exe` treats any redirected stdin as
 * an item template, so a call without input must leave stdin ignored rather
 * than attach an empty pipe. Every spawn hides its console window on Windows.
 */

import { spawn, spawnSync } from "node:child_process";
import { whichBin } from "../which.ts";

export interface OpRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Spawn-level failure code, such as `"ENOENT"` when the binary is absent. */
  spawnErrno?: string;
}

export interface OpRunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Bytes written to stdin, then closed. Absent leaves stdin ignored. */
  input?: string | Uint8Array;
  /** Kill the child after this many milliseconds. Absent means no limit. */
  timeoutMs?: number;
}

/** Run a command, capture its output, and resolve when it exits. Never rejects. */
export function runProcess(argv: string[], opts: OpRunOptions = {}): Promise<OpRunResult> {
  const [file, ...args] = argv;
  return new Promise<OpRunResult>((resolve) => {
    const hasInput = opts.input !== undefined;
    const child = spawn(file ?? "", args, {
      windowsHide: true,
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [hasInput ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));

    let settled = false;
    const timer =
      opts.timeoutMs === undefined ? undefined : setTimeout(() => child.kill(), opts.timeoutMs);
    const finish = (exitCode: number, stderrOverride?: string, spawnErrno?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString("utf-8"),
        stderr: stderrOverride ?? Buffer.concat(err).toString("utf-8"),
        exitCode,
        ...(spawnErrno ? { spawnErrno } : {}),
      });
    };
    child.on("error", (e: NodeJS.ErrnoException) => finish(127, e.message, e.code));
    child.on("close", (code) => finish(code ?? 1));

    if (hasInput && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    }
  });
}

/** Run a short command synchronously with stdin ignored. Never throws. */
export function runProcessSync(
  argv: string[],
  opts: Omit<OpRunOptions, "input"> = {},
): OpRunResult {
  const [file, ...args] = argv;
  const result = spawnSync(file ?? "", args, {
    windowsHide: true,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: opts.timeoutMs,
  });
  const errno = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    stdout: result.stdout?.toString("utf-8") ?? "",
    stderr: result.error ? result.error.message : (result.stderr?.toString("utf-8") ?? ""),
    exitCode: result.error ? 127 : (result.status ?? 1),
    ...(errno ? { spawnErrno: errno } : {}),
  };
}

/** Absolute path of an executable on PATH, or undefined. */
export function which(bin: string): string | undefined {
  return whichBin(bin);
}

/** Block the current thread for `ms` milliseconds (used between lock retries). */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read all of this process's stdin as UTF-8 text. */
export async function readStdinText(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
