/**
 * Fixture-based tests for the web UI's coord-reader. Drops disposable caches,
 * and canonical V3 events into a temporary coordination root,
 * then asserts the reader returns the expected shape.
 *
 * Lives in tests/unit/ alongside commander.test.ts so `bun test` picks it up.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-routing.ts";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "harn-coord-test-"));
process.env.HARNERY_COORD_ROOT = ROOT;

beforeAll(() => {
  const h = path.join(ROOT, ".harnery");
  mkdirSync(path.join(h, "active"), { recursive: true });
  mkdirSync(path.join(h, "journal"), { recursive: true });

  const now = new Date();
  const fresh = new Date(now.getTime() - 30_000).toISOString();
  const stale = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

  writeFileSync(
    path.join(h, "active", "abc-fresh.json"),
    JSON.stringify({
      instance_id: "abc-fresh",
      name: "Alpha",
      kind: "session",
      platform: "claude-code",
      last_heartbeat: fresh,
      files_touched: ["/a.ts", "/b.ts"],
      task: "writing tests",
      last_tool: "Bash",
      model: "claude-opus-4-7",
    }),
  );

  writeFileSync(
    path.join(h, "active", "def-stale.json"),
    JSON.stringify({
      instance_id: "def-stale",
      name: "Beta",
      kind: "session",
      platform: "cursor",
      last_heartbeat: stale,
      files_touched: ["/c.ts"],
    }),
  );

  writeFileSync(path.join(h, "active", "broken.json"), "{ this is not valid json");

  initializeEventLedgerV3({
    coordRoot: ROOT,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-coord-reader",
  });
  const route = resolveLiveEventLedgerRouteV3(ROOT);
  if (route.state !== "v3") throw new Error("expected V3 route");
  const record = (instanceId: string, eventName: string, payload: Record<string, unknown>) =>
    recordLiveHookSignalV3({
      coordRoot: ROOT,
      route,
      eventName,
      payload: { session_id: instanceId, raw: {}, ...payload },
      adapter: "claude-code",
      instanceId,
    });
  record("abc-fresh", "session-start", {});
  record("abc-fresh", "user-prompt-submit", { turn_id: "turn-alpha", prompt: "test" });
  record("abc-fresh", "pre-tool-use", { turn_id: "turn-alpha", tool_name: "Read" });
  record("def-stale", "session-start", {});

  writeFileSync(
    path.join(h, "journal", "abc-fresh.md"),
    `# Journal: Alpha\nsession_id: abc-fresh\nstarted: 2026-05-27 10:00 AM -05:00\nlast_updated: 2026-05-27 10:01 PM +05:30\n\n---\n\n## 2026-05-27 10:01 PM +05:30 · plan\nfirst entry\n## Findings\nkept in the body\n\n## 2026-05-27 10:00 AM -05:00 · note\nsecond entry\n`,
  );
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

// Dynamic import after env + fixtures set up so the cached coordRoot picks
// up our tmpdir (not the host project's real .harnery/).
const reader = await import(
  path.join(import.meta.dir, "..", "..", "web", "lib", "coord-reader.ts")
);

describe("coord-reader", () => {
  test("readAgents ignores unbound cache rows and reports them as invalid", () => {
    const snap = reader.readAgents();
    expect(snap.active.map((h: { name: string }) => h.name).sort()).toEqual([
      "abc-fresh",
      "def-stale",
    ]);
    expect(snap.stale).toEqual([]);
    expect(snap.meta.invalid.map((row: { file: string }) => row.file).sort()).toEqual([
      "abc-fresh.json",
      "broken.json",
      "def-stale.json",
    ]);
  });

  test("readAgents never trusts claims from unbound cache rows", () => {
    const snap = reader.readAgents();
    const paths = snap.claims.map((c: { path: string }) => c.path).sort();
    expect(paths).toEqual([]);
  });

  test("readAgent returns the V3 projection or null", () => {
    expect(reader.readAgent("abc-fresh")?.name).toBe("abc-fresh");
    expect(reader.readAgent("not-real")).toBeNull();
  });

  test("readEvents projects the V3 ledger newest-first with filter support", () => {
    const all = reader.readEvents({ limit: 10 });
    expect(all.rows.length).toBeGreaterThanOrEqual(4);
    expect(all.rows[0].event_type).toBe("session.started");

    const onlyAlpha = reader.readEvents({ instanceId: "inst_abc-fresh", limit: 10 });
    expect(
      onlyAlpha.rows.every((r: { instance_id: string }) => r.instance_id === "inst_abc-fresh"),
    ).toBe(true);

    const onlyPre = reader.readEvents({ type: "tool.requested", limit: 10 });
    expect(
      onlyPre.rows.every((r: { event_type: string }) => r.event_type === "tool.requested"),
    ).toBe(true);
  });

  test("readJournal parses entries and inverts to newest-first display", () => {
    const sc = reader.readJournal("abc-fresh");
    expect(sc.exists).toBe(true);
    expect(sc.entries.length).toBe(2);
    // Journal files are newest-first on disk (appendEntry unshifts the new
    // header to the top), and readJournal preserves that file order. So the
    // top entry (10:01 · plan) is newest and renders first; 10:00 · note is
    // second. See readJournal's "File is newest-first" note.
    expect(sc.entries[0].category).toBe("plan");
    expect(sc.entries[1].category).toBe("note");
    // The dashboard uses the CLI's codec: exact instants from the written offset.
    expect(sc.entries[0].ts_display).toBe("2026-05-27 10:01 PM +05:30");
    expect(sc.entries[0].ts_iso).toBe("2026-05-27T22:01:00+05:30");
    expect(sc.entries[0].body).toBe("first entry\n## Findings\nkept in the body");
    expect(sc.entries[1].ts_iso).toBe("2026-05-27T10:00:00-05:00");
    expect(sc.unreadable_lines).toEqual([]);
  });

  test("readJournal flags retired timestamps instead of guessing", () => {
    writeFileSync(
      path.join(ROOT, ".harnery", "journal", "retired.md"),
      "# Journal: agent-Old\nstarted: 2026-05-27 10:00 AM CDT\n\n---\n\n## 2026-05-27 10:00 AM CDT · note\nold entry\n",
    );
    const sc = reader.readJournal("retired");
    expect(sc.entries).toEqual([]);
    expect(sc.unreadable_lines).toEqual([2, 6]);
  });

  test("readJournal on missing instance returns empty doc", () => {
    const sc = reader.readJournal("not-here");
    expect(sc.exists).toBe(false);
    expect(sc.entries.length).toBe(0);
  });

  test("ageLabel formats seconds → s/m/h/d", () => {
    expect(reader.ageLabel(30)).toBe("30s ago");
    expect(reader.ageLabel(120)).toBe("2m ago");
    expect(reader.ageLabel(3700)).toMatch(/^1h \d+m ago$/);
    expect(reader.ageLabel(90_000)).toMatch(/^1d ago$/);
  });
});
