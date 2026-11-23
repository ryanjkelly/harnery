import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countScheduleLaunchesToday,
  createScheduleClaim,
  listScheduleClaims,
  markScheduleClaimAbandoned,
  markScheduleClaimFinished,
  markScheduleClaimStarted,
  readScheduleClaim,
  scheduleLocalDay,
  takeScheduleClaimRetry,
} from "./claims.ts";
import { scheduleClaimPath } from "./paths.ts";

let root: string;
const NOW = new Date("2026-11-22T12:00:00.000Z");
const AT = "2026-11-22T11:55:00.000Z";

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-claims-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function create(at = AT, kind: "scheduled" | "catch-up" | "manual" = "scheduled") {
  return createScheduleClaim({
    coordRoot: root,
    jobId: "nightly",
    scheduledFor: at,
    kind,
    now: NOW,
  });
}

describe("createScheduleClaim", () => {
  test("creates the claim once; a second create finds it", () => {
    const first = create();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.claim.state).toBe("claimed");
    expect(first.path).toBe(scheduleClaimPath(root, "nightly", AT));
    const second = create();
    expect(second).toEqual({ ok: false, reason: "exists", path: first.path });
    const read = readScheduleClaim(root, "nightly", AT);
    expect(read.state === "ok" && read.claim.run_id).toBe(first.claim.run_id);
  });

  test("normalises the instant to UTC", () => {
    const r = create("2026-11-22T05:55:00-06:00");
    expect(r.ok && r.claim.scheduled_for).toBe(AT);
  });

  test("refuses at the daily limit without creating a file", () => {
    const first = create("2026-11-22T10:00:00.000Z");
    if (!first.ok) throw new Error("setup");
    markScheduleClaimStarted(root, first.claim, { now: NOW, pid: 123 });
    const refused = createScheduleClaim({
      coordRoot: root,
      jobId: "nightly",
      scheduledFor: AT,
      kind: "scheduled",
      now: NOW,
      limit: { maxLaunchesPerDay: 1, zone: "UTC" },
    });
    expect(refused).toMatchObject({ ok: false, reason: "daily-limit", launchesToday: 1 });
    expect(existsSync(scheduleClaimPath(root, "nightly", AT))).toBe(false);
  });
});

describe("state changes", () => {
  test("claimed, started, finished", () => {
    const r = create();
    if (!r.ok) throw new Error("setup");
    const started = markScheduleClaimStarted(root, r.claim, { now: NOW, pid: 4242 });
    expect(started).toMatchObject({ state: "started", pid: 4242, started_at: NOW.toISOString() });
    const finished = markScheduleClaimFinished(root, started, { now: NOW });
    expect(finished.state).toBe("finished");
    expect(JSON.parse(readFileSync(r.path, "utf8")).state).toBe("finished");
  });

  test("refuses a change the state does not allow", () => {
    const r = create();
    if (!r.ok) throw new Error("setup");
    expect(() => markScheduleClaimFinished(root, r.claim, { now: NOW })).toThrow(/from claimed/);
    const started = markScheduleClaimStarted(root, r.claim, { now: NOW });
    expect(() => markScheduleClaimAbandoned(root, started, { now: NOW })).toThrow(/from started/);
    expect(() => markScheduleClaimStarted(root, r.claim, { now: NOW })).toThrow(/from started/);
  });

  test("abandons a claim that never started", () => {
    const r = create();
    if (!r.ok) throw new Error("setup");
    expect(markScheduleClaimAbandoned(root, r.claim, { now: NOW }).state).toBe("abandoned");
  });

  test("refuses to change an unreadable claim", () => {
    const r = create();
    if (!r.ok) throw new Error("setup");
    writeFileSync(r.path, "{");
    expect(() => markScheduleClaimStarted(root, r.claim, { now: NOW })).toThrow(/invalid/);
  });
});

describe("retry, list and count", () => {
  test("the retry can be taken once", () => {
    const r = create();
    if (!r.ok) throw new Error("setup");
    expect(takeScheduleClaimRetry(root, r.claim, NOW)).toBe(true);
    expect(takeScheduleClaimRetry(root, r.claim, NOW)).toBe(false);
    const [entry] = listScheduleClaims(root, "nightly");
    expect(entry?.retried).toBe(true);
  });

  test("lists oldest first, skips older names, and marks bad files", () => {
    create("2026-11-20T00:00:00.000Z");
    create("2026-11-22T00:00:00.000Z");
    const bad = create("2026-11-21T00:00:00.000Z");
    if (!bad.ok) throw new Error("setup");
    writeFileSync(bad.path, "not json");
    const all = listScheduleClaims(root, "nightly");
    expect(all.map((e) => e.scheduled_for)).toEqual([
      "2026-11-20T00:00:00.000Z",
      "2026-11-21T00:00:00.000Z",
      "2026-11-22T00:00:00.000Z",
    ]);
    expect(all[1]?.claim).toBeNull();
    const recent = listScheduleClaims(root, "nightly", {
      sinceMs: Date.parse("2026-11-21T00:00:00.000Z"),
    });
    expect(recent).toHaveLength(2);
    expect(listScheduleClaims(root, "other-job")).toEqual([]);
  });

  test("counts launches that started on the local day", () => {
    const a = create("2026-11-22T01:00:00.000Z");
    const b = create("2026-11-21T23:00:00.000Z");
    create("2026-11-22T02:00:00.000Z"); // never started
    if (!a.ok || !b.ok) throw new Error("setup");
    markScheduleClaimStarted(root, a.claim, { now: new Date("2026-11-22T01:00:00.000Z") });
    markScheduleClaimStarted(root, b.claim, { now: new Date("2026-11-21T23:00:00.000Z") });
    expect(countScheduleLaunchesToday(root, "nightly", NOW, "UTC")).toBe(1);
    // In Chicago both starts fall on 2026-11-21 local, and noon UTC is 2026-11-22 local.
    expect(countScheduleLaunchesToday(root, "nightly", NOW, "America/Chicago")).toBe(0);
    expect(scheduleLocalDay(NOW.getTime(), "UTC")).toBe("2026-11-22");
  });
});
