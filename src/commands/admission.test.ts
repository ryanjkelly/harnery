import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import {
  createJobDir,
  DURABLE_JOB_DOCUMENT_FILENAME,
  DURABLE_JOB_SCHEMA_VERSION,
  DURABLE_JOB_STATUS_FILENAME,
  type DurableJobDocument,
  type DurableJobStatus,
  jobsRoot,
  readJobStatus,
  writeJobDocument,
  writeJobStatus,
} from "../lib/durable-job.ts";
import { registerAdmissionCommand, superviseJob } from "./admission.ts";

interface CapturedEmit {
  emit: EmitContext;
  data: unknown[];
  logs: string[];
  errors: unknown[];
}

function captureEmit(): CapturedEmit {
  const data: unknown[] = [];
  const logs: string[] = [];
  const errors: unknown[] = [];
  const emit: EmitContext = {
    config() {},
    data(payload) {
      data.push(payload);
    },
    rows() {},
    text(s) {
      logs.push(s);
    },
    file() {},
    error(err) {
      errors.push(err);
    },
    log(msg) {
      logs.push(msg);
    },
    setExitCode(n) {
      process.exitCode = n;
    },
  };
  return { emit, data, logs, errors };
}

function buildProgram(emit: EmitContext): Command {
  const program = new Command();
  registerAdmissionCommand(program, emit);
  return program;
}

const roots: string[] = [];
let savedAdmissionDir: string | undefined;
let savedJobsDir: string | undefined;
let savedExitCode: typeof process.exitCode;
let savedArgv1: string | undefined;

beforeEach(() => {
  savedAdmissionDir = process.env.HARNERY_ADMISSION_DIR;
  savedJobsDir = process.env.HARNERY_JOBS_DIR;
  savedExitCode = process.exitCode;
  savedArgv1 = process.argv[1];
});

afterEach(() => {
  if (savedAdmissionDir === undefined) delete process.env.HARNERY_ADMISSION_DIR;
  else process.env.HARNERY_ADMISSION_DIR = savedAdmissionDir;
  if (savedJobsDir === undefined) delete process.env.HARNERY_JOBS_DIR;
  else process.env.HARNERY_JOBS_DIR = savedJobsDir;
  if (savedArgv1 !== undefined) process.argv[1] = savedArgv1;
  process.exitCode = savedExitCode;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureBaseDir(): string {
  const base = mkdtempSync(join(tmpdir(), "harnery-admission-cmd-"));
  roots.push(base);
  process.env.HARNERY_ADMISSION_DIR = base;
  process.env.HARNERY_JOBS_DIR = join(base, "jobs-root");
  return base;
}

function jobsBase(): string {
  const dir = process.env.HARNERY_JOBS_DIR;
  if (dir === undefined) throw new Error("fixtureBaseDir() must run first");
  return dir;
}

/** A PID that is guaranteed not to be running: a reaped child's. */
function deadPid(): number {
  const pid = spawnSync("/bin/true").pid;
  if (typeof pid !== "number") throw new Error("cannot obtain a reaped child pid");
  return pid;
}

function seedJob(jobId: string, status: Partial<DurableJobStatus>): string {
  const dir = createJobDir(jobsBase(), jobId);
  const stamp = new Date().toISOString();
  const document: DurableJobDocument = {
    schema_version: DURABLE_JOB_SCHEMA_VERSION,
    job_id: jobId,
    resource: "cmd-test",
    capacity: 1,
    label: "seeded job",
    argv: ["/bin/true"],
    cwd: tmpdir(),
    created_at: stamp,
  };
  writeJobDocument(dir, document);
  writeJobStatus(dir, {
    schema_version: DURABLE_JOB_SCHEMA_VERSION,
    job_id: jobId,
    pid: process.pid,
    state: "running",
    started_at: stamp,
    updated_at: stamp,
    ...status,
  } as DurableJobStatus);
  return dir;
}

describe("admission status", () => {
  test("--json lists a seeded holder", async () => {
    const base = fixtureBaseDir();
    mkdirSync(join(base, "browser-qa", "held"), { recursive: true });
    mkdirSync(join(base, "browser-qa", "tickets"), { recursive: true });
    const name = `${String(Date.now()).padStart(13, "0")}-${process.pid}-abcd1234.json`;
    writeFileSync(
      join(base, "browser-qa", "held", name),
      JSON.stringify({
        pid: process.pid,
        label: "seeded holder",
        created_at: new Date().toISOString(),
      }),
    );

    const { emit, data } = captureEmit();
    await buildProgram(emit).parseAsync(["admission", "status", "--json"], { from: "user" });

    expect(data).toHaveLength(1);
    const payload = data[0] as {
      resources: { resource: string; holders: { label: string }[]; waiters: unknown[] }[];
    };
    expect(payload.resources).toHaveLength(1);
    expect(payload.resources[0]?.resource).toBe("browser-qa");
    expect(payload.resources[0]?.holders.map((holder) => holder.label)).toEqual(["seeded holder"]);
    expect(payload.resources[0]?.waiters).toEqual([]);
  });
});

describe("admission run", () => {
  test("propagates exit 0 from /bin/true", async () => {
    fixtureBaseDir();
    const { emit, errors } = captureEmit();
    process.exitCode = undefined;
    await buildProgram(emit).parseAsync(
      ["admission", "run", "--resource", "cmd-test", "--", "/bin/true"],
      { from: "user" },
    );
    expect(errors).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("propagates exit 1 from /bin/false", async () => {
    fixtureBaseDir();
    const { emit } = captureEmit();
    process.exitCode = undefined;
    await buildProgram(emit).parseAsync(
      ["admission", "run", "--resource", "cmd-test", "--", "/bin/false"],
      { from: "user" },
    );
    expect(process.exitCode ?? 0).toBe(1);
  });
});

describe("admission run --detach", () => {
  test("creates a job record, launches a supervisor, and returns 0", async () => {
    const base = fixtureBaseDir();
    // Point the CLI-script lookup at an inert stub: the launch path is what is
    // under test, not the supervisor, which has its own test below.
    const stub = join(base, "stub-cli.ts");
    writeFileSync(stub, "process.exit(0);\n");
    process.argv[1] = stub;

    const { emit, logs, data, errors } = captureEmit();
    process.exitCode = undefined;
    await buildProgram(emit).parseAsync(
      [
        "admission",
        "run",
        "--detach",
        "--json",
        "--resource",
        "cmd-test",
        "--label",
        "detached smoke",
        "--",
        "/bin/true",
      ],
      { from: "user" },
    );

    expect(errors).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
    const envelope = data[0] as { detached: boolean; job_id: string; job_dir: string };
    expect(envelope.detached).toBe(true);
    expect(envelope.job_dir).toBe(join(jobsRoot(jobsBase()), envelope.job_id));
    expect(existsSync(join(envelope.job_dir, DURABLE_JOB_DOCUMENT_FILENAME))).toBe(true);
    expect(existsSync(join(envelope.job_dir, DURABLE_JOB_STATUS_FILENAME))).toBe(true);

    const document = JSON.parse(
      readFileSync(join(envelope.job_dir, DURABLE_JOB_DOCUMENT_FILENAME), "utf8"),
    ) as DurableJobDocument;
    expect(document.argv).toEqual(["/bin/true"]);
    expect(document.resource).toBe("cmd-test");
    expect(document.label).toBe("detached smoke");
    expect(readJobStatus(envelope.job_dir)?.state).toBe("launching");
    expect(logs.some((line) => line.includes("admission wait"))).toBe(true);
  });
});

describe("admission supervise", () => {
  test("runs the command to completion and records its exit code", async () => {
    fixtureBaseDir();
    const jobDir = createJobDir(jobsBase(), "job-supervised");
    writeJobDocument(jobDir, {
      schema_version: DURABLE_JOB_SCHEMA_VERSION,
      job_id: "job-supervised",
      resource: "cmd-test",
      capacity: 1,
      label: "supervised /bin/false",
      argv: ["/bin/false"],
      cwd: tmpdir(),
      created_at: new Date().toISOString(),
    });

    const { emit, errors } = captureEmit();
    process.exitCode = undefined;
    await superviseJob(emit, { jobDir });

    expect(errors).toEqual([]);
    const status = readJobStatus(jobDir);
    expect(status?.state).toBe("completed");
    expect(status?.exit_code).toBe(1);
    expect(status?.signal).toBeNull();
    expect(process.exitCode ?? 0).toBe(1);
    // The slot is released, so the resource is idle again.
    const { emit: statusEmit, data } = captureEmit();
    await buildProgram(statusEmit).parseAsync(["admission", "status", "--json"], { from: "user" });
    const payload = data[0] as { resources: { resource: string; holders: unknown[] }[] };
    for (const resource of payload.resources) expect(resource.holders).toEqual([]);
  });
});

describe("admission wait", () => {
  test("exits with the exit code of an already-completed job", async () => {
    fixtureBaseDir();
    const jobDir = seedJob("job-completed", {
      state: "completed",
      exit_code: 7,
      signal: null,
    });
    const { emit, errors } = captureEmit();
    process.exitCode = undefined;
    await buildProgram(emit).parseAsync(["admission", "wait", jobDir], { from: "user" });
    expect(errors).toEqual([]);
    expect(process.exitCode ?? 0).toBe(7);
  });

  test("exits 4 when the record says running but the supervisor pid is dead", async () => {
    fixtureBaseDir();
    const jobDir = seedJob("job-abandoned", { state: "running", pid: deadPid() });
    const { emit, logs } = captureEmit();
    process.exitCode = undefined;
    await buildProgram(emit).parseAsync(["admission", "wait", jobDir], { from: "user" });
    expect(process.exitCode ?? 0).toBe(4);
    expect(logs.some((line) => line.includes("dead"))).toBe(true);
  });

  test("exits 1 on a directory that is not a job record", async () => {
    const base = fixtureBaseDir();
    const { emit, errors } = captureEmit();
    process.exitCode = undefined;
    await buildProgram(emit).parseAsync(["admission", "wait", base], { from: "user" });
    expect(process.exitCode ?? 0).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

describe("admission jobs", () => {
  test("lists seeded jobs newest first", async () => {
    fixtureBaseDir();
    seedJob("job-first", { state: "completed", exit_code: 0, signal: null });
    seedJob("job-second", { state: "running", pid: deadPid() });

    const { emit, data } = captureEmit();
    process.exitCode = undefined;
    await buildProgram(emit).parseAsync(["admission", "jobs", "--json"], { from: "user" });
    const payload = data[0] as { dir: string; jobs: { job_id: string }[] };
    expect(payload.jobs.map((job) => job.job_id).sort()).toEqual(["job-first", "job-second"]);
  });
});
