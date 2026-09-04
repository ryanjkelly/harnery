import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { planScheduledBackup, scheduledBackupInvocation } from "./backup-schedule.ts";

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
      });
      expect(invocation?.harnBin.endsWith("/bin/harn"), adapter).toBeTrue();
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
