import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failingLockDirSeam } from "../../../tests/helpers/lock-dir-seam.ts";
import {
  addGrant,
  endGrants,
  liveGrant,
  logGrantEvent,
  readGrants,
  withGrantsLock,
} from "./grants.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const dir = () => mkdtempSync(join(tmpdir(), "desktop-grants-"));
const base = {
  owner_id: "a1",
  owner_label: "agent-A",
  project: "/p",
  kind: "task" as const,
  purpose: "export invoices",
  approved_via: "dialog" as const,
};

describe("desktop approvals", () => {
  test("an approval is live for its owner and project until it expires", () => {
    const d = dir();
    addGrant(d, base, { nowMs: NOW, durationMs: 60_000 });
    expect(liveGrant(d, "a1", "/p", NOW + 59_000)?.purpose).toBe("export invoices");
    expect(liveGrant(d, "a1", "/p", NOW + 60_000)).toBeUndefined();
    expect(liveGrant(d, "a1", "/other", NOW)).toBeUndefined();
    expect(liveGrant(d, "b2", "/p", NOW)).toBeUndefined();
  });

  test("a new approval replaces the owner's earlier one and drops expired records", () => {
    const d = dir();
    addGrant(d, { ...base, owner_id: "old" }, { nowMs: NOW - 120_000, durationMs: 60_000 });
    addGrant(d, base, { nowMs: NOW, durationMs: 60_000 });
    addGrant(d, { ...base, purpose: "second" }, { nowMs: NOW, durationMs: 60_000 });
    const all = readGrants(d);
    expect(all.map((g) => g.purpose)).toEqual(["second"]);
  });

  test("ending filters by owner and kind", () => {
    const d = dir();
    addGrant(d, base, { nowMs: NOW, durationMs: 60_000 });
    addGrant(d, { ...base, owner_id: "s1", kind: "session" }, { nowMs: NOW, durationMs: 60_000 });
    expect(endGrants(d, { nowMs: NOW, kind: "task" }).map((g) => g.owner_id)).toEqual(["a1"]);
    expect(readGrants(d).map((g) => g.owner_id)).toEqual(["s1"]);
    expect(endGrants(d, { nowMs: NOW }).map((g) => g.owner_id)).toEqual(["s1"]);
    expect(readGrants(d)).toEqual([]);
  });

  test("a malformed file counts as no approvals", () => {
    const d = dir();
    logGrantEvent(d, { event: "requested" }, NOW);
    expect(readGrants(d)).toEqual([]);
  });

  test("every decision is appended to the log", () => {
    const d = dir();
    logGrantEvent(d, { event: "requested", owner_label: "agent-A", purpose: "x" }, NOW);
    logGrantEvent(d, { event: "denied", owner_label: "agent-A", via: "dialog" }, NOW);
    const lines = readFileSync(join(d, "grants-log.ndjson"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(["requested", "denied"]);
    expect(JSON.parse(lines[0]!).at).toBe("2026-11-01T12:00:00.000Z");
  });
});

describe("grants lock on Windows", () => {
  test("EPERM from a lock folder being removed waits on win32, as EEXIST does", () => {
    const seam = failingLockDirSeam("EPERM", "win32", 2);
    expect(withGrantsLock(dir(), () => "ran", seam)).toBe("ran");
    // The lock folder never existed, so the stale check's stat failed and the loop retried.
    expect(seam.calls).toBe(3);
  });

  test("EEXIST waits the same way", () => {
    const seam = failingLockDirSeam("EEXIST", "linux", 2);
    expect(withGrantsLock(dir(), () => "ran", seam)).toBe("ran");
    expect(seam.calls).toBe(3);
  });

  test("EPERM on other platforms is still a real error", () => {
    const seam = failingLockDirSeam("EPERM", "linux");
    let ran = false;
    expect(() =>
      withGrantsLock(
        dir(),
        () => {
          ran = true;
        },
        seam,
      ),
    ).toThrow("EPERM");
    expect(ran).toBe(false);
    expect(seam.calls).toBe(1);
  });
});
