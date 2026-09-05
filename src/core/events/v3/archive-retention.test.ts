import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventLedgerArchivePolicy } from "../../config.ts";
import {
  autoCleanEventV3Archives,
  cleanEventV3Archives,
  eventV3ArchivesRoot,
  inventoryEventV3Archives,
} from "./archive-retention.ts";

const roots: string[] = [];
const now = new Date("2026-09-01T06:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "harnery-epoch-retention-"));
  roots.push(path);
  return path;
}

function policy(overrides: Partial<EventLedgerArchivePolicy> = {}): EventLedgerArchivePolicy {
  return { maxBytes: 1024, maxAgeDays: 7, keepMin: 2, autoClean: true, ...overrides };
}

function epoch(repo: string, stamp: string, bytes: number, modifiedAt = now): string {
  const path = join(eventV3ArchivesRoot(repo), `epoch-${stamp}`);
  mkdirSync(path, { recursive: true });
  const payload = join(path, "active.ndjson");
  writeFileSync(payload, "x".repeat(bytes));
  utimesSync(payload, modifiedAt, modifiedAt);
  utimesSync(path, modifiedAt, modifiedAt);
  return path;
}

describe("Event Ledger V3 archive retention", () => {
  test("archive cleanup stays daily while artifact cleanup runs hourly", () => {
    const repo = root();
    epoch(repo, "20260901000000000", 10);
    expect(autoCleanEventV3Archives(repo, { now }).ran).toBe(true);
    expect(
      autoCleanEventV3Archives(repo, { now: new Date(now.getTime() + 2 * 3_600_000) }).reason,
    ).toBe("fresh");
    expect(
      autoCleanEventV3Archives(repo, { now: new Date(now.getTime() + 25 * 3_600_000) }).ran,
    ).toBe(true);
  });
  test("keeps the newest minimum and selects oldest complete epochs to satisfy the byte budget", () => {
    const repo = root();
    epoch(repo, "20260801000000000", 40);
    epoch(repo, "20260802000000000", 40);
    epoch(repo, "20260803000000000", 40);
    epoch(repo, "20260804000000000", 40);

    const rows = inventoryEventV3Archives(repo, {
      now,
      policy: policy({ maxBytes: 100, maxAgeDays: 365 }),
    });
    expect(rows.map((row) => row.classification)).toEqual([
      "over-budget",
      "over-budget",
      "protected-minimum",
      "protected-minimum",
    ]);
  });

  test("expires old epochs but never deletes unmanaged entries or top-level symlinks", () => {
    const repo = root();
    const old = new Date("2026-08-01T00:00:00.000Z");
    epoch(repo, "20260801000000000", 10, old);
    epoch(repo, "20260831000000000", 10);
    epoch(repo, "20260901000000000", 10);
    mkdirSync(join(eventV3ArchivesRoot(repo), "manual-backup"), { recursive: true });
    symlinkSync(tmpdir(), join(eventV3ArchivesRoot(repo), "epoch-20260701000000000"));

    const rows = inventoryEventV3Archives(repo, { now, policy: policy() });
    expect(rows.find((row) => row.name === "epoch-20260801000000000")).toMatchObject({
      classification: "expired",
      action: "would-delete",
    });
    expect(rows.find((row) => row.name === "manual-backup")?.classification).toBe("unmanaged");
    expect(rows.find((row) => row.name === "epoch-20260701000000000")?.classification).toBe(
      "symlink",
    );
  });

  test("deletes only entries that still match the current plan", () => {
    const repo = root();
    const old = epoch(repo, "20260801000000000", 10, new Date("2026-08-01T00:00:00.000Z"));
    epoch(repo, "20260831000000000", 10);
    epoch(repo, "20260901000000000", 10);

    const rows = cleanEventV3Archives(repo, { yes: true, now, policy: policy() });
    expect(rows.find((row) => row.path === old)?.action).toBe("deleted");
    expect(existsSync(old)).toBe(false);
  });
});
