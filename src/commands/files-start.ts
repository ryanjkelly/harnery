/**
 * Start the local dashboard for `files url` when it does not answer.
 *
 * A link to a local file is useless until the dashboard serves it, and a fresh
 * machine has nothing that starts the dashboard. A project may opt in by
 * naming its start command in `.harnery/config.jsonc`:
 *
 *   "files": { "start_command": ["<bin>", "web", "up"], "start_timeout_seconds": 600 }
 *
 * `files url` then runs that command once, detached, and polls until the
 * dashboard reports this repository's identity. Several sessions can ask at
 * the same moment, so the start is serialized by a no-clobber lease: the
 * winner spawns the command, everyone else only waits for the dashboard. A
 * lease left by a crashed caller expires after the start timeout and is then
 * recoverable once its owner process is gone.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripJsonComments } from "../core/config.ts";
import { acquireNoClobberLease } from "../core/storage/no-clobber-lease.ts";

/** Default bound on how long `files url` waits for a started dashboard. */
export const DEFAULT_VIEWER_START_TIMEOUT_SECONDS = 600;

export interface ViewerStartConfig {
  /** argv of the start command; run with the coord root as working directory. */
  command: string[];
  timeoutMs: number;
}

export class ViewerStartConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewerStartConfigError";
  }
}

function readFilesSection(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const files = (parsed as Record<string, unknown>).files;
  return files && typeof files === "object" && !Array.isArray(files)
    ? (files as Record<string, unknown>)
    : undefined;
}

function userConfigFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg?.trim() ? xdg : join(homedir(), ".config");
  return join(base, "harnery", "config.jsonc");
}

/**
 * The effective `files.start_command` and `files.start_timeout_seconds`,
 * layered user, then project, then machine-local (later wins per key).
 * Returns null when no layer names a start command. An invalid value throws,
 * so a typo is reported instead of silently disabling the start.
 */
export function readViewerStartConfig(
  coordRoot: string,
  userFile: string = userConfigFile(),
): ViewerStartConfig | null {
  let command: unknown;
  let timeout: unknown;
  for (const file of [
    userFile,
    join(coordRoot, ".harnery", "config.jsonc"),
    join(coordRoot, ".harnery", "config.local.jsonc"),
  ]) {
    const files = readFilesSection(file);
    if (!files) continue;
    if (files.start_command !== undefined) command = files.start_command;
    if (files.start_timeout_seconds !== undefined) timeout = files.start_timeout_seconds;
  }
  if (command === undefined || command === null) return null;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string" && part.length > 0)
  ) {
    throw new ViewerStartConfigError(
      "files.start_command must be a non-empty array of non-empty strings",
    );
  }
  let seconds = DEFAULT_VIEWER_START_TIMEOUT_SECONDS;
  if (timeout !== undefined) {
    if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > 86_400) {
      throw new ViewerStartConfigError(
        "files.start_timeout_seconds must be an integer from 1 through 86400",
      );
    }
    seconds = timeout as number;
  }
  return { command: command as string[], timeoutMs: seconds * 1000 };
}

/** Quote an argv for display in an error or hint. */
export function displayCommand(command: string[]): string {
  return command
    .map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

export type ProbeOutcome =
  | { kind: "ready" }
  | { kind: "waiting"; message: string }
  | { kind: "fatal"; error: Error };

export interface EnsureViewerOptions {
  coordRoot: string;
  config: ViewerStartConfig;
  /** One health check of the dashboard. */
  probe: () => Promise<ProbeOutcome>;
  /** Called once when this caller spawns the command, and while waiting. */
  onProgress?: (message: string) => void;
  spawnImpl?: (command: string[], cwd: string, logPath: string) => ChildProcess;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}

export interface EnsureViewerResult {
  /** True when this caller ran the start command; false when a peer did. */
  started: boolean;
  logPath: string;
}

export class ViewerStartError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "ViewerStartError";
  }
}

/** Where the start lease and the start command's log live. */
export function viewerStartPaths(coordRoot: string): { dir: string; lease: string; log: string } {
  const dir = join(coordRoot, ".harnery", "files-viewer");
  return { dir, lease: join(dir, "start-lease"), log: join(dir, "start.log") };
}

function defaultSpawn(command: string[], cwd: string, logPath: string): ChildProcess {
  const fd = openSync(logPath, "a");
  try {
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
}

/**
 * Take the start lease, or report that a live peer holds it. A lease left by
 * a dead caller is reclaimed once it has expired; an unexpired one, or one
 * whose owner may still be alive, is treated as a peer's start in progress.
 */
function tryAcquireStartLease(
  leaseDir: string,
  timeoutMs: number,
  now: () => number,
): { release(): void } | null {
  mkdirSync(leaseDir, { recursive: true });
  const authority = createHash("sha256").update(`files-viewer-start:${leaseDir}`).digest("hex");
  try {
    return acquireNoClobberLease({
      path: leaseDir,
      scope: "files-viewer-start",
      authoritySha256: authority,
      staleAfterMs: timeoutMs,
      now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/held by a live|recovery is already in progress|raced with another/.test(message)) {
      return null;
    }
    throw error;
  }
}

/**
 * Make the dashboard answer: start it when this caller wins the start lease,
 * then poll `probe` until it reports ready, the start command fails, or the
 * configured timeout passes. Throws ViewerStartError naming the command.
 */
export async function ensureViewerStarted(
  options: EnsureViewerOptions,
): Promise<EnsureViewerResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = options.pollMs ?? 1_000;
  const { dir, lease: leaseDir, log } = viewerStartPaths(options.coordRoot);
  const shown = displayCommand(options.config.command);
  mkdirSync(dir, { recursive: true });

  const lease = tryAcquireStartLease(leaseDir, options.config.timeoutMs, now);
  let started = false;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  try {
    if (lease) {
      // A peer may have finished its start between our failed check and the lease.
      const recheck = await options.probe();
      if (recheck.kind === "ready") return { started: false, logPath: log };
      if (recheck.kind === "fatal") throw recheck.error;
      options.onProgress?.(`dashboard is not running; starting it with: ${shown}`);
      let child: ChildProcess;
      try {
        child = (options.spawnImpl ?? defaultSpawn)(options.config.command, options.coordRoot, log);
      } catch (error) {
        throw new ViewerStartError(
          `could not run the dashboard start command: ${shown} (${error instanceof Error ? error.message : String(error)})`,
          `Fix files.start_command in .harnery/config.jsonc, or start the dashboard yourself and retry.`,
        );
      }
      started = true;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("exit", (code, signal) => {
        exit = { code, signal };
      });
    } else {
      options.onProgress?.("another session is starting the dashboard; waiting for it");
    }

    const deadline = now() + options.config.timeoutMs;
    let last = "it has not answered yet";
    while (true) {
      const outcome = await options.probe();
      if (outcome.kind === "ready") return { started, logPath: log };
      if (outcome.kind === "fatal") throw outcome.error;
      last = outcome.message;
      if (spawnError) {
        throw new ViewerStartError(
          `could not run the dashboard start command: ${shown} (${spawnError.message})`,
          `Fix files.start_command in .harnery/config.jsonc, or start the dashboard yourself and retry.`,
        );
      }
      if (exit && exit.code !== 0) {
        throw new ViewerStartError(
          `dashboard start command failed (${exit.code ?? exit.signal}): ${shown}`,
          `Read ${log} for the cause, then run the command yourself and retry.`,
        );
      }
      if (now() >= deadline) {
        throw new ViewerStartError(
          `dashboard did not answer within ${Math.round(options.config.timeoutMs / 1000)}s after ${started ? "running" : "a peer ran"}: ${shown} (${last})`,
          `Read ${log}, run the command yourself, or raise files.start_timeout_seconds, then retry.`,
        );
      }
      await sleep(pollMs);
    }
  } finally {
    lease?.release();
  }
}
