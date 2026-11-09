/**
 * Start npm-installed CLIs on Windows without a shell.
 *
 * npm installs `codex`, `cursor-agent` and often `claude` on Windows as `.cmd`
 * launchers. Node and Bun refuse to spawn a `.cmd` or `.bat` file without a
 * shell (EINVAL since the 2024 batch-file argument fix), and running one
 * through `cmd.exe` would expose prompt text to cmd's quoting rules. Every npm
 * launcher ends by running Node on a script beside it, so this module reads that
 * script from the launcher and runs it directly. A launcher in another format
 * is reported as unlaunchable instead of failing with a bare EINVAL.
 *
 * Off Windows, and for `.exe`/`.com` targets, the command is returned unchanged.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

/** The script an npm cmd-shim runs: `"%_prog%"  "%dp0%\<relative script>" %*`. */
const NPM_SHIM_TARGET = /"%dp0%\\([^"\r\n]+)"\s+%\*/i;

export type WindowsLaunch = { file: string; args: string[] } | { error: string };

export function windowsLaunch(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): WindowsLaunch {
  if (platform !== "win32") return { file, args };
  const extension = extname(file).toLowerCase();
  if (extension === ".exe" || extension === ".com") return { file, args };
  const target = isBatch(extension) ? file : findOnPath(file, env);
  // Not found, or a native executable: spawn as before (a missing binary still
  // reports ENOENT to the caller).
  if (!target || !isBatch(extname(target).toLowerCase())) return { file, args };
  const script = npmShimScript(target);
  if (!script) {
    return {
      error: `${target} is a batch launcher that cannot be started without a shell; install a native executable or put its script's runtime on PATH`,
    };
  }
  const bundledNode = join(dirname(target), "node.exe");
  const node = isFile(bundledNode) ? bundledNode : (findOnPath("node", env) ?? process.execPath);
  return { file: node, args: [script, ...args] };
}

/** The absolute script path an npm cmd-shim runs, or null for any other launcher. */
export function npmShimScript(launcher: string): string | null {
  let text: string;
  try {
    text = readFileSync(launcher, "utf8");
  } catch {
    return null;
  }
  const match = NPM_SHIM_TARGET.exec(text);
  if (!match?.[1]) return null;
  const script = resolve(dirname(launcher), match[1]);
  return isFile(script) ? script : null;
}

function isBatch(extension: string): boolean {
  return extension === ".cmd" || extension === ".bat";
}

/** Lookups keyed by PATH, PATHEXT and name: hooks run git many times per turn. */
const lookups = new Map<string, string | undefined>();

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(name) || /[\\/]/.test(name)) return undefined;
  const path = env.PATH ?? env.Path ?? "";
  const pathext = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  const key = `${path}\0${pathext}\0${name}`;
  if (lookups.has(key)) return lookups.get(key);
  let found: string | undefined;
  search: for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const extension of pathext.split(";").filter(Boolean)) {
      const candidate = join(dir, name + extension.toLowerCase());
      if (isFile(candidate)) {
        found = candidate;
        break search;
      }
    }
  }
  // Remember hits only, so a CLI installed while a long process runs is found.
  if (found) lookups.set(key, found);
  return found;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
