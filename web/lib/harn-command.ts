/**
 * How the dashboard starts one of this project's Harnery executables.
 *
 * `bin/harn` and `bin/agent-coord` are POSIX shell wrappers with no file
 * extension, so Windows cannot start them (spawn fails with ENOENT). Each has
 * a `.mjs` twin that runs under the current runtime, so on Windows the
 * dashboard runs `<process.execPath> <bin>.mjs` instead, matching
 * `spawnCoordBinSync` in src/core/agents/coord-bin.ts. Elsewhere it runs the
 * wrapper itself.
 *
 * Every caller still passes `windowsHide: true`; the dashboard server has no
 * console of its own, so a child started without it opens a terminal window.
 */

import { existsSync } from "node:fs";
import path from "node:path";

export type HarneryExecutable = "harn" | "agent-coord";

export interface HarnCommand {
  command: string;
  args: string[];
}

export interface HarnCommandOptions {
  /** Which bundled executable to start. Defaults to `harn`. */
  executable?: HarneryExecutable;
  /** Injected by tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** The runtime that runs the `.mjs` twin on Windows; defaults to `process.execPath`. */
  execPath?: string;
  /** Injected by tests; defaults to `existsSync`. */
  exists?: (candidate: string) => boolean;
}

/**
 * Where the executable can live, in resolution order: a host project that
 * embeds Harnery at `<root>/harnery/`, then Harnery's own checkout.
 */
export function harneryBinCandidates(
  root: string,
  executable: HarneryExecutable = "harn",
): string[] {
  return [path.join(root, "harnery", "bin", executable), path.join(root, "bin", executable)];
}

/** The first candidate that exists on disk, or null when none does. */
export function harneryBinPath(
  root: string,
  executable: HarneryExecutable = "harn",
  exists: (candidate: string) => boolean = existsSync,
): string | null {
  return harneryBinCandidates(root, executable).find((candidate) => exists(candidate)) ?? null;
}

/**
 * The command and arguments that run `executable args...` for the project at
 * `root`. When no candidate exists the embedded path is used, so the spawn
 * fails with ENOENT and the caller's error path reports it.
 */
export function harnCommand(
  root: string,
  args: readonly string[],
  options: HarnCommandOptions = {},
): HarnCommand {
  const executable = options.executable ?? "harn";
  const bin =
    harneryBinPath(root, executable, options.exists) ??
    (harneryBinCandidates(root, executable)[0] as string);
  if ((options.platform ?? process.platform) === "win32") {
    return { command: options.execPath ?? process.execPath, args: [`${bin}.mjs`, ...args] };
  }
  return { command: bin, args: [...args] };
}

/**
 * The dashboard server's environment for a child Harnery process. The project
 * root is pinned, and NODE_OPTIONS is dropped: `harn web` preloads the
 * server's HTTP hooks through it (or a `--import` relative to web/ that a
 * child started in the project root cannot find), and a child CLI must not
 * inherit either.
 */
export function harnChildEnv(
  root: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, HARNERY_COORD_ROOT_OVERRIDE: root };
  delete env.NODE_OPTIONS;
  return env;
}
