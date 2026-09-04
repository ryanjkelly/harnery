import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduledBackupInvocation } from "./backup-schedule.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionStart backup schedule", () => {
  test("is disabled when backup.schedule is absent", () => {
    const root = fixture({ backup: { repo: "/tmp/restic" } });
    expect(scheduledBackupInvocation(root)).toBeNull();
  });

  test("builds the same detached snapshot for every adapter", () => {
    const root = fixture({
      backup: {
        repo: "/tmp/restic",
        schedule: { if_stale: "24h", tags: ["daily", "session-start"] },
      },
    });
    for (const adapter of ["claude-code", "codex", "cursor"]) {
      const invocation = scheduledBackupInvocation(root);
      expect(invocation, adapter).toMatchObject({
        ifStale: "24h",
        tags: ["daily", "session-start"],
        logFile: join(root, ".harnery", "logs", "backup-schedule.log"),
      });
      expect(invocation?.harnBin.endsWith("/bin/harn"), adapter).toBeTrue();
    }
  });
});

function fixture(config: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-backup-schedule-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"));
  writeFileSync(join(root, ".harnery", "config.jsonc"), JSON.stringify(config));
  return root;
}
