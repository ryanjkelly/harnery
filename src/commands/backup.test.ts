import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backupConfig } from "../core/config.ts";
import {
  backupCatalogCoverage,
  newestSnapshotTime,
  parseBackupDuration,
  readHostSnapshotCache,
  resolveBackupSelection,
  selectedLogicalBytes,
} from "./backup.ts";

const roots: string[] = [];
const hasRestic = spawnSync("restic", ["version"], { stdio: "ignore" }).status === 0;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("backup selection", () => {
  test("covers every storage family and excludes event ledgers and artifacts", () => {
    const root = fixture();
    const harnery = join(root, ".harnery");
    for (const entry of [
      "workflows",
      "work",
      "governors",
      "councils",
      "decisions",
      "journal",
      "identities",
      "mailbox",
      "approvals",
      "ledgers",
      "artifacts",
    ]) {
      mkdirSync(join(harnery, entry), { recursive: true });
      writeFileSync(join(harnery, entry, "one.json"), "{}\n");
    }
    writeFileSync(join(harnery, ".name-history"), "{}\n");
    const selection = resolveBackupSelection(root, backupConfig(root));
    expect(backupCatalogCoverage(root).uncovered).toEqual([]);
    expect(selection.targets).toContain(join(harnery, "mailbox"));
    expect(selection.targets).toContain(join(harnery, "approvals"));
    expect(selection.targets).toContain(join(harnery, ".name-history"));
    expect(selection.targets).not.toContain(join(harnery, "ledgers"));
    expect(selection.targets).not.toContain(join(harnery, "artifacts"));
  });

  test("applies relative include/exclude paths and measures unique logical bytes", () => {
    const root = fixture({
      backup: { include: ["extra"], exclude: ["workflows"] },
    });
    mkdirSync(join(root, ".harnery", "workflows"), { recursive: true });
    mkdirSync(join(root, ".harnery", "extra"), { recursive: true });
    writeFileSync(join(root, ".harnery", "workflows", "ignored"), "12345");
    writeFileSync(join(root, ".harnery", "extra", "kept"), "1234567");
    const selection = resolveBackupSelection(root, backupConfig(root));
    expect(selection.targets).toContain(join(root, ".harnery", "extra"));
    expect(selection.targets).not.toContain(join(root, ".harnery", "workflows"));
    expect(selectedLogicalBytes(selection.targets)).toBeGreaterThanOrEqual(7);
  });

  test("resolves a configured relative password file from the coordination root", () => {
    const root = fixture({ backup: { password_file: ".credentials/restic.password" } });
    expect(backupConfig(root).passwordFile).toBe(join(root, ".credentials", "restic.password"));
  });

  test("reads the newest snapshot time from restic JSON", () => {
    expect(
      newestSnapshotTime('[{"time":"2026-01-01T00:00:00Z"},{"time":"2026-01-03T00:00:00Z"}]'),
    ).toBe(Date.parse("2026-01-03T00:00:00Z"));
    expect(newestSnapshotTime("[]")).toBeNull();
    expect(newestSnapshotTime("not json")).toBeNull();
  });

  test("parses bounded freshness durations", () => {
    expect(parseBackupDuration("24h")).toBe(86_400_000);
    expect(parseBackupDuration("7d")).toBe(604_800_000);
    expect(parseBackupDuration("0h")).toBeNull();
    expect(parseBackupDuration("tomorrow")).toBeNull();
  });
});

describe.skipIf(!hasRestic)("backup command with a local restic repository", () => {
  test("initializes, snapshots, checks, lists, and restores durable state", () => {
    const root = fixture({
      backup: {
        repo: "restic-repo",
        password_file: ".credentials/restic.password",
        max_bytes: 52_428_800,
      },
    });
    mkdirSync(join(root, ".harnery", "decisions"), { recursive: true });
    writeFileSync(join(root, ".harnery", "decisions", "one.json"), '{"decision":"keep"}\n');
    const init = harn(root, ["backup", "init"]);
    expect(init.status, init.output).toBe(0);
    const snapshot = harn(root, ["backup", "snapshot", "--tag", "test"]);
    expect(snapshot.status, snapshot.output).toBe(0);
    const cache = readHostSnapshotCache(join(root, ".harnery"));
    expect(cache?.host).toBe(hostname());
    expect(Date.now() - (cache?.snapshotAt ?? 0)).toBeLessThan(60_000);
    const throttled = harn(root, ["backup", "snapshot", "--if-stale", "24h", "--tag", "duplicate"]);
    expect(throttled.status, throttled.output).toBe(0);
    expect(throttled.output).toContain("newer than 24h; skipped");
    const check = harn(root, ["backup", "check"]);
    expect(check.status, check.output).toBe(0);
    const list = harn(root, ["backup", "list", "--json"]);
    expect(list.status, list.output).toBe(0);
    const snapshots = JSON.parse(list.output) as Array<{ tags?: string[] }>;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.tags).toContain("test");
    const target = join(root, "restore");
    const restore = harn(root, ["backup", "restore", "latest", "--target", target]);
    expect(restore.status, restore.output).toBe(0);
    expect(findNamedFile(target, "one.json")).toBeTrue();
  }, 30_000);

  test("refuses a selected set above max_bytes", () => {
    const root = fixture({
      backup: {
        repo: "restic-repo",
        password_file: ".credentials/restic.password",
        max_bytes: 1,
      },
    });
    mkdirSync(join(root, ".harnery", "decisions"), { recursive: true });
    writeFileSync(join(root, ".harnery", "decisions", "one.json"), '{"larger":true}\n');
    const init = harn(root, ["backup", "init"]);
    expect(init.status, init.output).toBe(0);
    const snapshot = harn(root, ["backup", "snapshot"]);
    expect(snapshot.status, snapshot.output).toBe(1);
    expect(snapshot.output).toContain("backup_too_large");
    const list = harn(root, ["backup", "list", "--json"]);
    expect(list.status, list.output).toBe(0);
    expect(JSON.parse(list.output)).toHaveLength(0);
  }, 30_000);
});

function fixture(config: unknown = {}): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-backup-command-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  writeFileSync(join(root, ".harnery", "config.jsonc"), JSON.stringify(config));
  return root;
}

function harn(root: string, args: string[]): { status: number | null; output: string } {
  const bin = resolve(import.meta.dir, "../../bin/harn");
  const result = spawnSync("bash", [bin, ...args], {
    cwd: root,
    env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function findNamedFile(root: string, name: string): boolean {
  if (!existsSync(root)) return false;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.name === name) return true;
    }
  }
  return false;
}
