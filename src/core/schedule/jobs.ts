/**
 * The tracked job file (`.harnery/schedules.jsonc`): loading, finding a job,
 * resolving what a job would run on this machine, writing the file back, and
 * keeping it out of `.harnery/.gitignore`'s catch-all.
 */

import {
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { resolveTimeZone } from "../config.ts";
import {
  parseScheduleJobFileText,
  type ScheduleJob,
  type ScheduleJobFile,
  type ScheduleJobResolution,
  validateScheduleJobFile,
} from "./job-types.ts";
import { scheduleJobFilePath } from "./paths.ts";

export type ScheduleJobFileLoad =
  | { ok: true; file: ScheduleJobFile; path: string }
  | { ok: false; reason: "missing" | "invalid"; errors: string[]; path: string };

/** Read and validate the job file. A missing file is `missing`, not an empty list. */
export function loadScheduleJobFile(coordRoot: string): ScheduleJobFileLoad {
  const path = scheduleJobFilePath(coordRoot);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, reason: "missing", errors: [], path };
    }
    return {
      ok: false,
      reason: "invalid",
      errors: [`file: could not be read (${(error as Error).message})`],
      path,
    };
  }
  const parsed = parseScheduleJobFileText(text);
  if (!parsed.ok) return { ok: false, reason: "invalid", errors: parsed.errors, path };
  return { ok: true, file: parsed.value, path };
}

export function findScheduleJob(file: ScheduleJobFile, id: string): ScheduleJob | null {
  return file.jobs.find((job) => job.id === id) ?? null;
}

export type ScheduleEnv = Readonly<Record<string, string | undefined>>;
export type SchedulePathLookup = (name: string, env: ScheduleEnv) => string | null;

function envValue(env: ScheduleEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  // Windows variable names are case-insensitive (`Path`, `PATH`).
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function isRunnableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an executable name on `PATH` without a shell. On Windows each `PATH`
 * entry is tried with every `PATHEXT` extension (the bare name first when it
 * already has one). Returns the path as found, or null.
 */
export function findScheduleExecutableOnPath(
  name: string,
  env: ScheduleEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const dirs = (envValue(env, "PATH", platform) ?? "").split(platform === "win32" ? ";" : ":");
  let names = [name];
  if (platform === "win32") {
    const exts = (envValue(env, "PATHEXT", platform) || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .map((e) => e.trim())
      .filter(Boolean);
    const hasExt = exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
    names = hasExt ? [name, ...exts.map((e) => name + e)] : exts.map((e) => name + e);
  }
  for (const dir of dirs) {
    if (!dir) continue;
    const clean = platform === "win32" ? dir.replace(/^"(.*)"$/, "$1") : dir;
    for (const n of names) {
      const candidate = join(clean, n);
      if (isRunnableFile(candidate, platform)) return candidate;
    }
  }
  return null;
}

export interface ResolveScheduleJobOptions {
  coordRoot: string;
  env: ScheduleEnv;
  /** Test seam; defaults to `findScheduleExecutableOnPath`. */
  pathLookup?: SchedulePathLookup;
}

export type ScheduleJobResolutionResult = ScheduleJobResolution & {
  /** The `argv[0]` of every gather command whose executable was not found. */
  missing: string[];
};

/**
 * Resolve each gather command's `argv[0]` to an absolute real path: a bare
 * name is looked up on `PATH`, a relative path resolves against the checkout
 * root, and an absolute path is taken as written. Every found path then goes
 * through `realpathSync`, so a symlink that later points elsewhere changes the
 * job's hash. One not found resolves to "" and is listed in `missing`.
 */
export function resolveScheduleJob(
  job: ScheduleJob,
  opts: ResolveScheduleJobOptions,
): ScheduleJobResolutionResult {
  const lookup = opts.pathLookup ?? ((name, env) => findScheduleExecutableOnPath(name, env));
  const missing: string[] = [];
  const executables = (job.gather ?? []).map((g) => {
    const argv0 = g.argv[0] as string;
    let found: string | null;
    if (isAbsolute(argv0)) {
      found = argv0;
    } else if (/[\\/]/.test(argv0)) {
      found = resolve(opts.coordRoot, argv0);
    } else {
      found = lookup(argv0, opts.env);
    }
    let real = "";
    if (found !== null && existsSync(found)) {
      try {
        real = realpathSync(found);
      } catch {
        real = "";
      }
    }
    if (!real) missing.push(argv0);
    return real;
  });
  return { executables, zone: resolveTimeZone(opts.coordRoot), missing };
}

/**
 * Validate the file, then write it as pretty JSON atomically (temporary file
 * and rename). Comments and formatting in an existing JSONC file are lost on
 * rewrite. Throws with the validation errors when the file is invalid.
 */
export function writeScheduleJobFile(coordRoot: string, file: ScheduleJobFile): void {
  const checked = validateScheduleJobFile(file);
  if (!checked.ok) {
    throw new Error(`schedule job file is invalid:\n${checked.errors.join("\n")}`);
  }
  const path = scheduleJobFilePath(coordRoot);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

const TRACK_LINE = "!schedules.jsonc";

/**
 * Make `.harnery/.gitignore` let the job file through by adding
 * `!schedules.jsonc` when it is absent. Every other line is kept. Does
 * nothing when the project has no `.harnery/.gitignore`.
 */
export function ensureScheduleJobFileTracked(coordRoot: string): { changed: boolean } {
  const path = join(resolve(coordRoot), ".harnery", ".gitignore");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { changed: false };
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === TRACK_LINE)) return { changed: false };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const sep = text.length === 0 || text.endsWith("\n") ? "" : eol;
  writeFileSync(path, `${text}${sep}${TRACK_LINE}${eol}`, "utf8");
  return { changed: true };
}
