import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyJob,
  createJobDir,
  DURABLE_JOB_HEARTBEAT_STALE_MS,
  DURABLE_JOB_SCHEMA_VERSION,
  DURABLE_JOB_STATUS_FILENAME,
  type DurableJobDocument,
  type DurableJobStatus,
  jobExitCode,
  jobsRoot,
  listJobs,
  readJobDocument,
  readJobStatus,
  writeJobDocument,
  writeJobStatus,
} from "./durable-job.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function baseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "harnery-durable-job-"));
  roots.push(dir);
  return dir;
}

function documentFor(jobId: string, overrides: Partial<DurableJobDocument> = {}) {
  const document: DurableJobDocument = {
    schema_version: DURABLE_JOB_SCHEMA_VERSION,
    job_id: jobId,
    resource: "build",
    capacity: 1,
    label: "npm run build",
    argv: ["/bin/true"],
    cwd: "/tmp",
    created_at: new Date().toISOString(),
    ...overrides,
  };
  return document;
}

function statusFor(jobId: string, overrides: Partial<DurableJobStatus> = {}): DurableJobStatus {
  const stamp = new Date().toISOString();
  return {
    schema_version: DURABLE_JOB_SCHEMA_VERSION,
    job_id: jobId,
    pid: process.pid,
    state: "running",
    started_at: stamp,
    updated_at: stamp,
    ...overrides,
  };
}

/** A PID that is guaranteed not to be running: a reaped child's. */
function deadPid(): number {
  const result = spawnSync("/bin/true");
  const pid = result.pid;
  if (typeof pid !== "number") throw new Error("cannot obtain a reaped child pid");
  return pid;
}

describe("job record round-trip", () => {
  test("writes and reads back the document and status", () => {
    const base = baseDir();
    const dir = createJobDir(base, "job-a");
    expect(dir).toBe(join(jobsRoot(base), "job-a"));

    const document = documentFor("job-a");
    writeJobDocument(dir, document);
    expect(readJobDocument(dir)).toEqual(document);

    const status = statusFor("job-a", {
      state: "queued",
      queue: { resource: "build", waiting_since: "2026-09-01T00:00:00.000Z" },
    });
    writeJobStatus(dir, status);
    expect(readJobStatus(dir)).toEqual(status);
  });

  test("an unparseable status document reads as null", () => {
    const base = baseDir();
    const dir = createJobDir(base, "job-torn");
    writeFileSync(join(dir, DURABLE_JOB_STATUS_FILENAME), "{ not json");
    expect(readJobStatus(dir)).toBeNull();
  });
});

describe("classifyJob", () => {
  test("reports each written non-terminal state while the pid is alive", () => {
    const base = baseDir();
    for (const state of ["launching", "queued", "running"] as const) {
      const dir = createJobDir(base, `job-${state}`);
      writeJobDocument(dir, documentFor(`job-${state}`));
      writeJobStatus(dir, statusFor(`job-${state}`, { state, pid: 4242 }));
      const outcome = classifyJob(dir, { pidAlive: () => true });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.report.state).toBe(state);
      expect(outcome.report.terminal).toBe(false);
      expect(outcome.report.resource).toBe("build");
      expect(jobExitCode(outcome.report)).toBe(5);
    }
  });

  test("completed carries the exit code and is terminal", () => {
    const base = baseDir();
    const dir = createJobDir(base, "job-done");
    writeJobDocument(dir, documentFor("job-done"));
    writeJobStatus(dir, statusFor("job-done", { state: "completed", exit_code: 3, signal: null }));
    const outcome = classifyJob(dir);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.state).toBe("completed");
    expect(outcome.report.terminal).toBe(true);
    expect(outcome.report.exit_code).toBe(3);
    expect(jobExitCode(outcome.report)).toBe(3);
  });

  test("a job killed by a signal exits 1", () => {
    const base = baseDir();
    const dir = createJobDir(base, "job-signal");
    writeJobDocument(dir, documentFor("job-signal"));
    writeJobStatus(
      dir,
      statusFor("job-signal", { state: "completed", exit_code: null, signal: "SIGKILL" }),
    );
    const outcome = classifyJob(dir);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.signal).toBe("SIGKILL");
    expect(jobExitCode(outcome.report)).toBe(1);
  });

  test("a non-terminal state with a really-dead pid classifies as dead", () => {
    const base = baseDir();
    const dir = createJobDir(base, "job-dead");
    writeJobDocument(dir, documentFor("job-dead"));
    writeJobStatus(dir, statusFor("job-dead", { state: "running", pid: deadPid() }));
    const outcome = classifyJob(dir);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.state).toBe("dead");
    expect(outcome.report.terminal).toBe(false);
    expect(jobExitCode(outcome.report)).toBe(4);
  });

  test("heartbeat age is measured against the injected clock and warns when stale", () => {
    const base = baseDir();
    const dir = createJobDir(base, "job-stale");
    const updatedAt = "2026-09-01T00:00:00.000Z";
    writeJobDocument(dir, documentFor("job-stale"));
    writeJobStatus(
      dir,
      statusFor("job-stale", { state: "running", pid: 4242, updated_at: updatedAt }),
    );
    const nowMs = Date.parse(updatedAt) + DURABLE_JOB_HEARTBEAT_STALE_MS + 5_000;
    const outcome = classifyJob(dir, { pidAlive: () => true, now: () => nowMs });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.heartbeat_age_ms).toBe(DURABLE_JOB_HEARTBEAT_STALE_MS + 5_000);
    expect(outcome.report.state).toBe("running");
    expect(outcome.report.warnings).toHaveLength(1);
    expect(outcome.report.warnings[0]).toContain("heartbeat stale");
  });

  test("a directory without a status document is a usage error, not a state", () => {
    const base = baseDir();
    const dir = createJobDir(base, "job-empty");
    const outcome = classifyJob(dir);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain("not a job directory");
  });
});

describe("listJobs", () => {
  test("returns newest first and tolerates a missing base directory", () => {
    expect(listJobs(join(tmpdir(), "harnery-durable-job-absent-base"))).toEqual([]);

    const base = baseDir();
    const stamps: Record<string, string> = {
      "job-old": "2026-08-01T00:00:00.000Z",
      "job-mid": "2026-08-15T00:00:00.000Z",
      "job-new": "2026-09-01T00:00:00.000Z",
    };
    for (const [jobId, createdAt] of Object.entries(stamps)) {
      const dir = createJobDir(base, jobId);
      writeJobDocument(dir, documentFor(jobId, { created_at: createdAt }));
      writeJobStatus(dir, statusFor(jobId, { state: "completed", exit_code: 0, signal: null }));
    }
    const listed = listJobs(base);
    expect(listed.map((entry) => entry.job_id)).toEqual(["job-new", "job-mid", "job-old"]);
    expect(listed[0]?.report?.state).toBe("completed");
    expect(listed[0]?.created_at).toBe(stamps["job-new"]);
  });

  test("an unreadable record lists with its error instead of vanishing", () => {
    const base = baseDir();
    const dir = createJobDir(base, "job-broken");
    writeFileSync(join(dir, DURABLE_JOB_STATUS_FILENAME), "{ not json");
    const listed = listJobs(base);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.report).toBeNull();
    expect(listed[0]?.error).toContain("not a readable job status document");
  });
});
