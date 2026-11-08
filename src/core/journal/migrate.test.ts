import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendEntry,
  deleteEntry,
  editEntry,
  JournalNeedsMigrationError,
  loadJournal,
  withJournalLock,
} from "./index.ts";
import {
  convertRetiredStamp,
  hasRetiredJournalStamps,
  MIGRATION_BACKUP_DIR,
  migrateJournals,
  rewriteRetiredStamps,
} from "./migrate.ts";

const RETIRED = [
  "# Journal: agent-Old",
  "session_id: s-old",
  "machine: box",
  "started: 2026-11-01 1:30 AM CDT",
  "last_updated: 2026-11-07 10:38 PM CST",
  "",
  "---",
  "",
  "## 2026-11-07 10:38 PM CST · handoff",
  "summary",
  "## Findings",
  "## 2026-11-07 10:38 PM CST · idea",
  "  ## 2026-11-07 10:38 PM CST · note",
  "trailing spaces stay   ",
  "",
  "## 2026-11-01 1:30 AM CST · note",
  "second 1:30, after fall-back",
  "",
  "## 2026-11-01 1:30 AM CDT · plan",
  "first 1:30",
  "",
].join("\n");

const MIGRATED = [
  "# Journal: agent-Old",
  "session_id: s-old",
  "machine: box",
  "started: 2026-11-01 1:30 AM -05:00",
  "last_updated: 2026-11-07 10:38 PM -06:00",
  "",
  "---",
  "",
  "## 2026-11-07 10:38 PM -06:00 · handoff",
  "summary",
  "## Findings",
  "## 2026-11-07 10:38 PM CST · idea",
  "  ## 2026-11-07 10:38 PM CST · note",
  "trailing spaces stay   ",
  "",
  "## 2026-11-01 1:30 AM -06:00 · note",
  "second 1:30, after fall-back",
  "",
  "## 2026-11-01 1:30 AM -05:00 · plan",
  "first 1:30",
  "",
].join("\n");

let root: string;
let dir: string;
const priorRoot = process.env.HARNERY_COORD_ROOT_OVERRIDE;
const priorZone = process.env.HARNERY_TIME_ZONE;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-journal-migrate-"));
  dir = join(root, ".harnery", "journal");
  mkdirSync(join(dir, "archived"), { recursive: true });
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  process.env.HARNERY_TIME_ZONE = "America/Chicago";
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
  else process.env.HARNERY_COORD_ROOT_OVERRIDE = priorRoot;
  if (priorZone === undefined) delete process.env.HARNERY_TIME_ZONE;
  else process.env.HARNERY_TIME_ZONE = priorZone;
  rmSync(root, { recursive: true, force: true });
});

describe("retired stamp conversion", () => {
  test("maps CDT and CST to their fixed offsets and keeps the wall clock", () => {
    expect(convertRetiredStamp("2026-07-04 9:05 AM CDT")).toEqual({
      stamp: "2026-07-04 9:05 AM -05:00",
    });
    expect(convertRetiredStamp("2026-12-24 12:00 PM CST")).toEqual({
      stamp: "2026-12-24 12:00 PM -06:00",
    });
    expect(convertRetiredStamp("2026-02-30 1:00 AM CST")).toEqual({
      error: "invalid calendar date",
    });
    expect(convertRetiredStamp("2026-02-03 13:00 AM CST")).toEqual({ error: "hour outside 1-12" });
  });

  test("rewrites only headers and metadata; bodies stay byte-identical", () => {
    const result = rewriteRetiredStamps(RETIRED);
    expect(result.content).toBe(MIGRATED);
    expect(result.headers).toBe(3);
    expect(result.metadata).toBe(2);
    expect(result.unparseable).toEqual([]);
    expect(rewriteRetiredStamps(result.content).content).toBe(result.content);
  });

  test("the migrated file parses with the same entries the retired parser saw", () => {
    writeFileSync(join(dir, "old.md"), MIGRATED);
    const doc = loadJournal("old", root)!;
    expect(doc.unreadable_lines).toEqual([]);
    expect(doc.entries.map((e) => [e.category, e.ts_iso])).toEqual([
      ["handoff", "2026-11-07T22:38:00-06:00"],
      ["note", "2026-11-01T01:30:00-06:00"],
      ["plan", "2026-11-01T01:30:00-05:00"],
    ]);
    expect(doc.entries[0]!.body).toBe(
      "summary\n## Findings\n## 2026-11-07 10:38 PM CST · idea\n  ## 2026-11-07 10:38 PM CST · note\ntrailing spaces stay",
    );
  });
});

describe("migrateJournals", () => {
  test("dry run reports counts and changes nothing", () => {
    writeFileSync(join(dir, "old.md"), RETIRED);
    writeFileSync(join(dir, "archived", "old-2026-11-01.md"), RETIRED);
    const report = migrateJournals(dir);
    expect(report.applied).toBe(false);
    expect(report).toMatchObject({
      files_scanned: 2,
      files_changed: 2,
      headers: 6,
      metadata: 4,
      unparseable: 0,
      backup_dir: null,
    });
    expect(readFileSync(join(dir, "old.md"), "utf8")).toBe(RETIRED);
    expect(existsSync(join(dir, MIGRATION_BACKUP_DIR))).toBe(false);
  });

  test("apply rewrites active and archived files, saves pre-images, keeps mtimes, is idempotent", () => {
    const active = join(dir, "old.md");
    const archived = join(dir, "archived", "old-2026-11-01.md");
    writeFileSync(active, RETIRED);
    writeFileSync(archived, RETIRED);
    writeFileSync(join(dir, "current.md"), MIGRATED);
    const oldTime = new Date("2026-11-03T12:00:00Z");
    utimesSync(archived, oldTime, oldTime);
    const before = statSync(archived).mtimeMs;

    const report = migrateJournals(dir, { apply: true, now: new Date("2026-11-08T05:00:00Z") });
    expect(report.files_scanned).toBe(3);
    expect(report.files_changed).toBe(2);
    expect(readFileSync(active, "utf8")).toBe(MIGRATED);
    expect(readFileSync(archived, "utf8")).toBe(MIGRATED);
    expect(Math.abs(statSync(archived).mtimeMs - before)).toBeLessThan(1);
    expect(report.backup_dir).toStartWith(join(dir, MIGRATION_BACKUP_DIR));
    expect(readFileSync(join(report.backup_dir!, "old.md"), "utf8")).toBe(RETIRED);
    expect(readFileSync(join(report.backup_dir!, "archived", "old-2026-11-01.md"), "utf8")).toBe(
      RETIRED,
    );
    expect(existsSync(join(report.backup_dir!, "current.md"))).toBe(false);
    expect(hasRetiredJournalStamps(dir)).toBe(false);

    const again = migrateJournals(dir, { apply: true });
    expect(again.files_changed).toBe(0);
    expect(again.backup_dir).toBeNull();
  });

  test("reports retired-looking stamps it cannot convert and leaves them", () => {
    const bad = RETIRED.replace(
      "## 2026-11-07 10:38 PM CST · handoff",
      "## 2026-02-30 10:38 PM CST · handoff",
    );
    writeFileSync(join(dir, "bad.md"), bad);
    const report = migrateJournals(dir, { apply: true });
    expect(report.unparseable).toBe(1);
    expect(report.files[0]!.unparseable[0]).toMatchObject({
      line: 9,
      reason: "invalid calendar date",
    });
    expect(readFileSync(join(dir, "bad.md"), "utf8")).toContain(
      "## 2026-02-30 10:38 PM CST · handoff",
    );
  });
});

describe("writers refuse files they cannot read", () => {
  test("append, edit, and delete name the migrate command and leave the file alone", () => {
    const path = join(dir, "old.md");
    writeFileSync(path, RETIRED);
    expect(() => appendEntry("old", "note", "new", { root })).toThrow(JournalNeedsMigrationError);
    expect(() => appendEntry("old", "note", "new", { root })).toThrow(/journal migrate/);
    expect(() => editEntry("old", 0, "2026-11-07 10:38 PM CST", "note", "x", root)).toThrow(
      JournalNeedsMigrationError,
    );
    expect(() => deleteEntry("old", 0, "2026-11-07 10:38 PM CST", root)).toThrow(
      JournalNeedsMigrationError,
    );
    expect(readFileSync(path, "utf8")).toBe(RETIRED);
    expect(existsSync(join(dir, "archived"))).toBe(true);
  });

  test("append writes the resolved zone with its offset after migration", () => {
    writeFileSync(join(dir, "old.md"), RETIRED);
    migrateJournals(dir, { apply: true });
    const doc = appendEntry("old", "done", "after", {
      root,
      now: new Date("2026-11-08T05:00:00Z"),
    });
    expect(doc.entries[0]).toMatchObject({
      ts_display: "2026-11-07 11:00 PM -06:00",
      ts_iso: "2026-11-07T23:00:00-06:00",
      category: "done",
    });
    expect(doc.entries).toHaveLength(4);
    expect(doc.header.started).toBe("2026-11-01 1:30 AM -05:00");
    expect(doc.header.last_updated).toBe("2026-11-07 11:00 PM -06:00");
  });

  test("a new journal follows HARNERY_TIME_ZONE", () => {
    process.env.HARNERY_TIME_ZONE = "Asia/Kathmandu";
    const doc = appendEntry("fresh", "note", "hello", {
      root,
      now: new Date("2026-11-08T04:38:00Z"),
    });
    expect(doc.entries[0]!.ts_display).toBe("2026-11-08 10:23 AM +05:45");
    expect(doc.header.started).toBe("2026-11-08 10:23 AM +05:45");
  });
});

describe("journal lock", () => {
  test("an append from another process waits for a migration holding the lock", async () => {
    const path = join(dir, "old.md");
    writeFileSync(path, RETIRED);
    const ready = join(root, "child-ready");
    const script = [
      `import { writeFileSync } from "node:fs";`,
      `import { appendEntry } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};`,
      `writeFileSync(${JSON.stringify(ready)}, "1");`,
      `appendEntry("old", "note", "from the child", { root: ${JSON.stringify(root)} });`,
    ].join("\n");
    const scriptPath = join(root, "child.ts");
    writeFileSync(scriptPath, script);

    let child: ReturnType<typeof Bun.spawn> | null = null;
    let exitedWhileLocked = false;
    withJournalLock(dir, () => {
      child = Bun.spawn([process.execPath, scriptPath], {
        env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root, HARNERY_TIME_ZONE: "UTC" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = Date.now() + 20_000;
      while (!existsSync(ready) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      expect(existsSync(ready)).toBe(true);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      exitedWhileLocked = child.exitCode !== null;
      // The child is blocked on the lock; the file is still the retired one.
      expect(readFileSync(path, "utf8")).toBe(RETIRED);
      migrateJournals(dir, { apply: true });
    });
    expect(exitedWhileLocked).toBe(false);
    const proc = child as unknown as ReturnType<typeof Bun.spawn>;
    const code = await proc.exited;
    expect(code).toBe(0);

    const doc = loadJournal("old", root)!;
    expect(doc.unreadable_lines).toEqual([]);
    expect(doc.entries.map((e) => e.body)[0]).toBe("from the child");
    expect(doc.entries).toHaveLength(4);
    expect(doc.entries[0]!.ts_display).toEndWith("+00:00");
  }, 30_000);
});
