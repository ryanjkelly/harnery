/**
 * Per-machine enrollment of a scheduler job: the record that says this
 * machine and this checkout may run the job exactly as it was hashed, and the
 * machine-wide registry that keeps one checkout per repository on a machine
 * from running a job another checkout already runs.
 *
 * Two checkouts or worktrees of one repository each have their own
 * `.harnery/private/`, so the registry lives outside any checkout, under the
 * user's state directory: `$XDG_STATE_HOME/harnery/schedule-enrollments/`
 * (default `~/.local/state`, `%LOCALAPPDATA%` on Windows when XDG is unset),
 * keyed by repository and job.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { originUrl } from "../presence/git.ts";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import { PERSONAL_DIR_MODE, PERSONAL_FILE_MODE } from "../storage/modes.ts";
import {
  hashScheduleJob,
  isScheduleKebabId,
  type ScheduleEnrollment,
  type ScheduleJob,
  type ScheduleJobResolution,
  validateScheduleEnrollment,
} from "./job-types.ts";
import { scheduleEnrollmentPath } from "./paths.ts";

// ---------------------------------------------------------------------------
// The machine-wide registry
// ---------------------------------------------------------------------------

/** One registry entry: which checkout on this machine holds a job. */
export interface ScheduleRegistryEntry {
  checkout: string;
  machine: string;
  enrolled_at: string;
}

/**
 * The user-level directory for the registry. Harnery keeps other
 * machine-wide state under `$XDG_STATE_HOME/harnery` (default
 * `~/.local/state/harnery`); on Windows with no XDG variable set this uses
 * `%LOCALAPPDATA%\harnery`.
 */
export function scheduleRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg) return join(xdg, "harnery", "schedule-enrollments");
  if (process.platform === "win32" && env.LOCALAPPDATA?.trim()) {
    return join(env.LOCALAPPDATA.trim(), "harnery", "schedule-enrollments");
  }
  return join(homedir(), ".local", "state", "harnery", "schedule-enrollments");
}

function gitCommonDir(root: string): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
    });
    const out = r.status === 0 ? r.stdout.trim() : "";
    if (!out) return null;
    return realpathSync(isAbsolute(out) ? out : resolve(root, out));
  } catch {
    return null;
  }
}

/**
 * A short key for the repository a checkout belongs to: a sha256 prefix of
 * the `origin` URL, else of the git common directory's real path (shared by
 * every worktree), else of the checkout's own real path.
 */
export function scheduleRepoKey(coordRoot: string): string {
  const origin = originUrl(coordRoot);
  const common = origin ? null : gitCommonDir(coordRoot);
  const basis = origin
    ? `origin:${origin}`
    : common
      ? `git:${common}`
      : `path:${checkoutRealPath(coordRoot)}`;
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function registryEntryPath(registryDir: string, repoKey: string, jobId: string): string {
  if (!isScheduleKebabId(jobId)) throw new Error(`schedule registry: bad job id: ${jobId}`);
  return join(registryDir, repoKey, `${jobId}.json`);
}

function readRegistryEntry(path: string): ScheduleRegistryEntry | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ScheduleRegistryEntry> | null;
    if (
      value &&
      typeof value.checkout === "string" &&
      typeof value.machine === "string" &&
      typeof value.enrolled_at === "string"
    ) {
      return { checkout: value.checkout, machine: value.machine, enrolled_at: value.enrolled_at };
    }
  } catch {
    // Missing or unreadable: treated as no entry.
  }
  return null;
}

function writeRegistryEntry(path: string, entry: ScheduleRegistryEntry): void {
  mkdirSync(dirname(path), { recursive: true, mode: PERSONAL_DIR_MODE });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: PERSONAL_FILE_MODE,
  });
  try {
    chmodSync(temporary, PERSONAL_FILE_MODE);
  } catch {
    // Windows does not expose POSIX modes.
  }
  renameSync(temporary, path);
}

function checkoutRealPath(coordRoot: string): string {
  try {
    return realpathSync(coordRoot);
  } catch {
    return resolve(coordRoot);
  }
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export interface EnrollScheduleJobOptions {
  coordRoot: string;
  job: ScheduleJob;
  /** From `resolveScheduleJob`; `missing` lists executables that were not found. */
  resolved: ScheduleJobResolution & { missing?: readonly string[] };
  /** `resolveMachineLabel()`. */
  machine: string;
  now: Date;
  enrolledBy?: string;
  /** Test seam for the machine-wide registry; defaults to `scheduleRegistryDir()`. */
  registryDir?: string;
}

export type EnrollScheduleJobResult =
  | { ok: true; enrollment: ScheduleEnrollment }
  | { ok: false; reason: "wrong-host" | "other-checkout" | "missing-executable"; detail: string };

/**
 * Enroll a job on this machine and checkout. Refuses when the job names
 * another host, when a gather executable is missing, or when the machine-wide
 * registry names a different checkout that still exists. A registry entry
 * whose checkout is gone is replaced. Enrolling again in the same checkout
 * rewrites the record with a new `enrolled_at`.
 */
export function enrollScheduleJob(opts: EnrollScheduleJobOptions): EnrollScheduleJobResult {
  const { coordRoot, job, resolved, machine } = opts;
  if (job.host !== machine) {
    return {
      ok: false,
      reason: "wrong-host",
      detail: `job "${job.id}" runs on host "${job.host}", and this machine is "${machine}"`,
    };
  }
  const missing = [
    ...(resolved.missing ?? []),
    ...(job.gather ?? [])
      .filter((_, i) => !resolved.executables[i])
      .map((g) => g.argv[0] as string),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "missing-executable",
      detail: `cannot find ${[...new Set(missing)].map((m) => `"${m}"`).join(", ")}`,
    };
  }
  const checkout = checkoutRealPath(coordRoot);
  const registryDir = opts.registryDir ?? scheduleRegistryDir();
  const entryPath = registryEntryPath(registryDir, scheduleRepoKey(coordRoot), job.id);
  const existing = readRegistryEntry(entryPath);
  if (existing && existing.checkout !== checkout && existsSync(existing.checkout)) {
    return {
      ok: false,
      reason: "other-checkout",
      detail: `job "${job.id}" is already enrolled on this machine in ${existing.checkout}`,
    };
  }
  const enrolledAt = opts.now.toISOString();
  const enrollment: ScheduleEnrollment = {
    schema_version: 1,
    job_id: job.id,
    job_hash: hashScheduleJob(job, resolved),
    machine,
    checkout,
    enrolled_at: enrolledAt,
    ...(opts.enrolledBy ? { enrolled_by: opts.enrolledBy } : {}),
  };
  writePrivateJsonAtomic(scheduleEnrollmentPath(coordRoot, job.id), enrollment);
  writeRegistryEntry(entryPath, { checkout, machine, enrolled_at: enrolledAt });
  return { ok: true, enrollment };
}

/** The stored enrollment, validated; null when missing, unreadable or invalid. */
export function readScheduleEnrollment(
  coordRoot: string,
  jobId: string,
): ScheduleEnrollment | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(scheduleEnrollmentPath(coordRoot, jobId), "utf8"),
    );
    const checked = validateScheduleEnrollment(value);
    if (!checked.ok || checked.value.job_id !== jobId) return null;
    return checked.value;
  } catch {
    return null;
  }
}

export interface CheckScheduleEnrollmentOptions {
  coordRoot: string;
  job: ScheduleJob;
  resolved: ScheduleJobResolution;
  machine: string;
}

export type ScheduleEnrollmentCheck =
  | { state: "enrolled"; enrollment: ScheduleEnrollment }
  | {
      state: "not-enrolled" | "changed" | "wrong-machine" | "wrong-checkout";
      detail: string;
      enrollment?: ScheduleEnrollment;
    };

/**
 * Whether this machine and checkout may run the job now. Checked in order:
 * `not-enrolled`, `wrong-machine` (the stored machine or `job.host` is not
 * this machine), `wrong-checkout` (stored for another checkout path), then
 * `changed` (the execution fields hash differently). Only `enrolled` runs.
 */
export function checkScheduleEnrollment(
  opts: CheckScheduleEnrollmentOptions,
): ScheduleEnrollmentCheck {
  const { coordRoot, job, resolved, machine } = opts;
  const enrollment = readScheduleEnrollment(coordRoot, job.id);
  if (!enrollment) {
    return { state: "not-enrolled", detail: `job "${job.id}" is not enrolled in this checkout` };
  }
  if (enrollment.machine !== machine || job.host !== machine) {
    return {
      state: "wrong-machine",
      detail:
        enrollment.machine !== machine
          ? `enrolled on "${enrollment.machine}", and this machine is "${machine}"`
          : `the job now names host "${job.host}", and this machine is "${machine}"`,
      enrollment,
    };
  }
  const checkout = checkoutRealPath(coordRoot);
  if (enrollment.checkout !== checkout) {
    return {
      state: "wrong-checkout",
      detail: `enrolled for ${enrollment.checkout}, and this checkout is ${checkout}`,
      enrollment,
    };
  }
  if (hashScheduleJob(job, resolved) !== enrollment.job_hash) {
    return {
      state: "changed",
      detail: `job "${job.id}" changed since it was enrolled; enroll it again to run it`,
      enrollment,
    };
  }
  return { state: "enrolled", enrollment };
}

/**
 * Remove the job's enrollment from this checkout, and its registry entry when
 * that entry names this checkout. Returns whether an enrollment file existed.
 */
export function removeScheduleEnrollment(
  coordRoot: string,
  jobId: string,
  opts: { registryDir?: string } = {},
): { removed: boolean } {
  const path = scheduleEnrollmentPath(coordRoot, jobId);
  const removed = existsSync(path);
  rmSync(path, { force: true });
  const entryPath = registryEntryPath(
    opts.registryDir ?? scheduleRegistryDir(),
    scheduleRepoKey(coordRoot),
    jobId,
  );
  const entry = readRegistryEntry(entryPath);
  if (entry && entry.checkout === checkoutRealPath(coordRoot)) rmSync(entryPath, { force: true });
  return { removed };
}
