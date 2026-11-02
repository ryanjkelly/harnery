/**
 * Helpers shared by the desktop driver adapters (ADRs 0228 and 0231): process
 * spawning with CRLF normalization, JSON parsing, architecture mapping, WSL
 * path translation, and the driver preference-file merge.
 *
 * Internal module: not exported from package.json.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { windowsPathToWsl, wslPathToWindows } from "../browser/windows-chrome.ts";
import type { DriverCallResult, HostInfo } from "./types.ts";

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type SpawnSyncFn = (
  command: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => SpawnResult;

export type SpawnDetachedFn = (command: string, args: string[], env: NodeJS.ProcessEnv) => void;

export const defaultSpawnSync: SpawnSyncFn = (command, args, options) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeout,
    env: options.env,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
};

export const defaultSpawnDetached: SpawnDetachedFn = (command, args, env) => {
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
};

export function normalize(text: string | undefined): string {
  return (text ?? "").replace(/\r\n?/g, "\n");
}

export function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** Path API for the caller's syntax on this host. */
export function pathApi(host: HostInfo): typeof posix {
  return host.kind === "windows" ? win32 : posix;
}

/** The shared desktop state directory, or a plain error for an unsupported host. */
export function requireStateDir(host: HostInfo): string {
  if (host.kind === "unsupported" || !host.desktopStateDir)
    throw new Error(
      `Computer use is not supported on this host: ${host.reason ?? "no shared desktop state directory"}`,
    );
  return host.desktopStateDir;
}

/** Map a process architecture onto the two architectures drivers publish. */
export function archLabel(arch: string): "x86_64" | "arm64" | undefined {
  if (arch === "x64" || arch === "x86_64" || arch === "amd64") return "x86_64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  return undefined;
}

/** Fold a spawn result into a DriverCallResult, noting timeouts and spawn failures. */
export function toCallResult(
  label: string,
  timeout: number,
  result: SpawnResult,
): DriverCallResult {
  const stdout = normalize(result.stdout);
  let stderr = normalize(result.stderr);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const note =
      code === "ETIMEDOUT"
        ? `${label} timed out after ${Math.round(timeout / 1000)}s`
        : `${label} failed to run: ${result.error.message}`;
    stderr = stderr ? `${stderr.replace(/\n$/, "")}\n${note}\n` : `${note}\n`;
  }
  const out: DriverCallResult = {
    exitCode: result.status ?? (result.error ? -1 : 1),
    stdout,
    stderr,
  };
  const json = parseJson(stdout);
  if (json !== undefined) out.json = json;
  return out;
}

export interface WslPaths {
  /** Caller (WSL) path to Windows syntax. Works for a file that does not exist yet. */
  toWindows(path: string): string;
  /** Windows path back to the caller's syntax. */
  toCaller(path: string): string;
}

/** WSL <-> Windows path conversion through `wslpath`, with string fallbacks. */
export function wslPaths(
  wslpath: (flag: "-w" | "-u", path: string) => string | undefined,
): WslPaths {
  return {
    toWindows(path) {
      const converted = wslpath("-w", path);
      if (converted) return converted;
      if (/^\/mnt\/[a-z]\//.test(path)) return wslPathToWindows(path);
      // wslpath can refuse a path that does not exist yet (an output file).
      const dir = posix.dirname(path);
      const parent = dir !== path ? wslpath("-w", dir) : undefined;
      return parent ? `${parent.replace(/\\$/, "")}\\${posix.basename(path)}` : path;
    },
    toCaller(path) {
      const converted = wslpath("-u", path);
      if (converted) return converted;
      try {
        return windowsPathToWsl(path);
      } catch {
        return path;
      }
    },
  };
}

export function defaultWslpath(
  run: SpawnSyncFn,
  env: () => NodeJS.ProcessEnv,
  timeout: number,
): (flag: "-w" | "-u", path: string) => string | undefined {
  return (flag, path) => {
    const result = run("wslpath", [flag, path], { timeout, env: env() });
    const value = normalize(result.stdout).trim();
    return result.status === 0 && value ? value : undefined;
  };
}

/** One row of the process table: `command` is the full command line, or the executable path for `comm`. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * Read the process table with `ps` (macOS and Linux). `field` picks the full
 * command line (`command`) or just the executable path (`comm`). Returns an
 * empty list when `ps` fails, so callers degrade to "nothing found".
 */
export function readProcessTable(
  run: SpawnSyncFn,
  env: NodeJS.ProcessEnv,
  field: "command" | "comm",
): ProcessRow[] {
  const result = run("ps", ["-axww", "-o", `pid=,ppid=,${field}=`], { timeout: 10_000, env });
  if (result.status !== 0) return [];
  const rows: ProcessRow[] = [];
  for (const line of normalize(result.stdout).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (match)
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: (match[3] ?? "").trim(),
      });
  }
  return rows;
}

/**
 * The macOS app a process runs inside, for naming where a permission grant
 * must go. macOS attributes Accessibility and Screen Recording requests from a
 * command-line tool to the app that launched it, which is the outermost app
 * bundle among the process's ancestors (a terminal, an editor, an agent app).
 * Within one executable path the outermost `.app` wins, so an editor's helper
 * (`/Applications/Editor.app/Contents/Frameworks/Helper.app/...`) resolves to
 * "Editor". Returns undefined when no ancestor runs from an app bundle.
 */
export function responsibleAppName(rows: ProcessRow[], startPid: number): string | undefined {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let found: string | undefined;
  const seen = new Set<number>();
  let pid = startPid;
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) break;
    const app = /\/([^/]+)\.app\//.exec(row.command)?.[1];
    if (app) found = app;
    pid = row.ppid;
  }
  return found;
}

/** Block the current thread for `ms` (short waits inside a synchronous driver method). */
export function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Merge `preferences` into a JSON object file, atomically, keeping other keys. */
export function mergePreferences(
  file: string,
  preferences: Record<string, unknown>,
  p: typeof posix,
): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").replace(/^﻿/, "");
    if (raw.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(
          `Driver preference file ${file} is not valid JSON; fix or remove it, then retry.`,
        );
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(`Driver preference file ${file} is not a JSON object.`);
      existing = parsed as Record<string, unknown>;
    }
  }
  const merged = { ...existing, ...preferences };
  mkdirSync(p.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`);
  renameSync(temp, file);
}

/** Add `name` to `WSLENV` so a Windows child launched from WSL sees it. */
export function withWslEnv(env: NodeJS.ProcessEnv, names: string[]): NodeJS.ProcessEnv {
  const entries = (env.WSLENV ?? "").split(":").filter(Boolean);
  for (const name of names)
    if (!entries.some((entry) => entry.split("/")[0] === name)) entries.push(name);
  return { ...env, WSLENV: entries.join(":") };
}
