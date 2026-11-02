import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { harnCliEntry } from "../cli-entry.ts";
import {
  planScheduledBackup,
  scheduleBackupSnapshot,
  scheduledBackupInvocation,
} from "./backup-schedule.ts";
import {
  runScheduledBackupWorker,
  SCHEDULED_BACKUP_LOG_KEEP_BYTES,
  SCHEDULED_BACKUP_LOG_MAX_BYTES,
  type ScheduledBackupWorkerSpec,
} from "./backup-schedule-worker.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionStart backup schedule", () => {
  test("is disabled when backup.schedule is absent", () => {
    const root = fixture({ backup: { repo: "/tmp/restic" } });
    expect(scheduledBackupInvocation(root)).toBeNull();
    expect(planScheduledBackup(root).action).toBe("disabled");
  });

  test("builds the same detached snapshot for every adapter", () => {
    const root = fixture(scheduled());
    for (const adapter of ["claude-code", "codex", "cursor"]) {
      const invocation = scheduledBackupInvocation(root);
      expect(invocation, adapter).toMatchObject({
        ifStale: "24h",
        tags: ["daily", "session-start"],
        logFile: join(root, ".harnery", "logs", "backup-schedule.log"),
        statusFile: join(root, ".harnery", "logs", "backup-schedule.status.json"),
        // The runtime runs the CLI script itself, so no shell wrapper is involved.
        cliEntry: harnCliEntry(),
      });
    }
  });

  test("launches when no local host cache exists", () => {
    const root = fixture(scheduled());
    expect(planScheduledBackup(root)).toMatchObject({ action: "launch", cue: null });
  });

  test("skips the remote check while the local host cache is fresh", () => {
    const root = fixture(scheduled());
    const now = Date.parse("2026-01-02T12:00:00Z");
    writeHostCache(root, hostname(), "2026-01-02T00:00:00Z");
    expect(planScheduledBackup(root, now).action).toBe("fresh");
    writeHostCache(root, hostname(), "2026-01-01T11:00:00Z");
    expect(planScheduledBackup(root, now).action).toBe("launch");
  });

  test("ignores a cache written by another host", () => {
    const root = fixture(scheduled());
    const now = Date.parse("2026-01-02T12:00:00Z");
    writeHostCache(root, `${hostname()}-other`, "2026-01-02T11:59:00Z");
    expect(planScheduledBackup(root, now).action).toBe("launch");
  });

  test("reports the last failed run and relaunches even when the cache is fresh", () => {
    const root = fixture(scheduled());
    const now = Date.parse("2026-01-02T12:00:00Z");
    writeHostCache(root, hostname(), "2026-01-02T11:00:00Z");
    writeFileSync(
      join(root, ".harnery", "logs", "backup-schedule.status.json"),
      '{"exit_code":1,"finished_at":"2026-01-02T11:30:00Z"}\n',
    );
    const plan = planScheduledBackup(root, now);
    expect(plan.action).toBe("launch");
    expect(plan.cue).toContain("failed (exit 1 at 2026-01-02T11:30:00Z)");
    expect(plan.cue).toContain("backup-schedule.log");
  });

  test("stays quiet after a successful run", () => {
    const root = fixture(scheduled());
    mkdirSync(join(root, ".harnery", "logs"), { recursive: true });
    writeFileSync(
      join(root, ".harnery", "logs", "backup-schedule.status.json"),
      '{"exit_code":0,"finished_at":"2026-01-02T11:30:00Z"}\n',
    );
    expect(planScheduledBackup(root).cue).toBeNull();
  });
});

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

describe("scheduled backup worker", () => {
  test("logs the CLI's output and records a successful exit", async () => {
    const spec = workerSpec(fakeCli(0));
    expect(await runScheduledBackupWorker(spec)).toBe(0);
    const lines = readFileSync(spec.logFile, "utf8").trimEnd().split("\n");
    expect(lines[0]).toMatch(/^\S+Z scheduled snapshot start \(if-stale 24h\)$/);
    expect(lines).toContain("out: backup snapshot --if-stale 24h --tag daily --tag session-start");
    expect(lines).toContain("err: to stderr");
    expect(lines.at(-1)).toMatch(/^\S+Z scheduled snapshot exit 0$/);
    const status = readStatus(spec.statusFile);
    expect(status.exit_code).toBe(0);
    expect(status.finished_at).toMatch(STAMP);
    expect(existsSync(`${spec.statusFile}.tmp`)).toBeFalse();
  });

  test("records a failing exit code", async () => {
    const spec = workerSpec(fakeCli(3));
    expect(await runScheduledBackupWorker(spec)).toBe(3);
    expect(readFileSync(spec.logFile, "utf8")).toMatch(/scheduled snapshot exit 3\n$/);
    expect(readStatus(spec.statusFile).exit_code).toBe(3);
  });

  test("records exit 127 when the CLI entry does not exist", async () => {
    const root = tempRoot();
    const spec = workerSpec(join(root, "missing-cli.mjs"));
    expect(await runScheduledBackupWorker(spec)).toBe(127);
    const log = readFileSync(spec.logFile, "utf8");
    expect(log).toContain("missing-cli.mjs");
    expect(log).toMatch(/scheduled snapshot exit 127\n$/);
    expect(readStatus(spec.statusFile).exit_code).toBe(127);
  });

  test("records exit 127 when the runtime cannot start", async () => {
    const root = tempRoot();
    const spec = { ...workerSpec(fakeCli(0)), runtime: join(root, "no-such-runtime") };
    expect(await runScheduledBackupWorker(spec)).toBe(127);
    expect(readStatus(spec.statusFile).exit_code).toBe(127);
    expect(readFileSync(spec.logFile, "utf8")).toMatch(/scheduled snapshot exit 127\n$/);
  });

  test("keeps only the newest bytes once the log passes its limit", async () => {
    const spec = workerSpec(fakeCli(0));
    const tail = "t".repeat(SCHEDULED_BACKUP_LOG_KEEP_BYTES);
    writeFileSync(spec.logFile, `${"h".repeat(SCHEDULED_BACKUP_LOG_MAX_BYTES)}${tail}`);
    await runScheduledBackupWorker(spec);
    const log = readFileSync(spec.logFile, "utf8");
    expect(log.startsWith(tail)).toBeTrue();
    expect(log.includes("hh")).toBeFalse();
    expect(log.slice(tail.length)).toMatch(/^\S+Z scheduled snapshot start/);
    expect(existsSync(`${spec.logFile}.rotating`)).toBeFalse();
  });

  test("leaves a log at the limit unrotated", async () => {
    const spec = workerSpec(fakeCli(0));
    const body = "h".repeat(SCHEDULED_BACKUP_LOG_MAX_BYTES);
    writeFileSync(spec.logFile, body);
    await runScheduledBackupWorker(spec);
    expect(readFileSync(spec.logFile, "utf8").startsWith(body)).toBeTrue();
  });
});

describe("scheduleBackupSnapshot", () => {
  test("runs the detached worker without a shell and records its result", async () => {
    const root = fixture(scheduled());
    const cli = fakeCli(5);
    const result = scheduleBackupSnapshot(root, { cliEntry: cli });
    expect(result).toEqual({ launched: true, cue: null });
    const statusFile = join(root, ".harnery", "logs", "backup-schedule.status.json");
    const deadline = Date.now() + 20_000;
    while (!existsSync(statusFile) && Date.now() < deadline) await Bun.sleep(50);
    expect(readStatus(statusFile).exit_code).toBe(5);
    const log = readFileSync(join(root, ".harnery", "logs", "backup-schedule.log"), "utf8");
    expect(log).toContain("out: backup snapshot --if-stale 24h --tag daily --tag session-start");
    // The CLI runs from the project root.
    expect(log).toContain(`cwd: ${root}`);
    expect(log).toMatch(/scheduled snapshot exit 5\n$/);
  }, 30_000);
});

function workerSpec(cliEntry: string): ScheduledBackupWorkerSpec {
  const root = tempRoot();
  return {
    cliEntry,
    ifStale: "24h",
    tags: ["daily", "session-start"],
    logFile: join(root, "backup-schedule.log"),
    statusFile: join(root, "backup-schedule.status.json"),
  };
}

/** A stand-in CLI entry that echoes its arguments and exits with `code`. */
function fakeCli(code: number): string {
  const path = join(tempRoot(), "fake-cli.mjs");
  writeFileSync(
    path,
    `const nl = String.fromCharCode(10);
process.stdout.write("out: " + process.argv.slice(2).join(" ") + nl);
process.stdout.write("cwd: " + process.cwd() + nl);
process.stderr.write("err: to stderr" + nl);
process.exit(${code});
`,
  );
  return path;
}

function readStatus(statusFile: string): { exit_code: number; finished_at: string } {
  return JSON.parse(readFileSync(statusFile, "utf8"));
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-backup-worker-"));
  roots.push(root);
  return root;
}

function scheduled(): unknown {
  return {
    backup: {
      repo: "/tmp/restic",
      schedule: { if_stale: "24h", tags: ["daily", "session-start"] },
    },
  };
}

function writeHostCache(root: string, host: string, snapshotAt: string): void {
  mkdirSync(join(root, ".harnery", "logs"), { recursive: true });
  writeFileSync(
    join(root, ".harnery", "logs", "backup-host-snapshot.json"),
    `${JSON.stringify({ host, snapshot_at: snapshotAt, recorded_at: snapshotAt })}\n`,
  );
}

function fixture(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-backup-schedule-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"));
  writeFileSync(join(root, ".harnery", "config.jsonc"), JSON.stringify(config));
  return root;
}
