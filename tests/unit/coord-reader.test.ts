/**
 * Fixture-based tests for the web UI's coord-reader. Drops fake heartbeats +
 * council manifest + events.ndjson into a tmp .harnery/ via HARNERY_COORD_ROOT,
 * then asserts the reader returns the expected shape.
 *
 * Lives in tests/unit/ alongside commander.test.ts so `bun test` picks it up.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "harn-coord-test-"));
process.env.HARNERY_COORD_ROOT = ROOT;

beforeAll(() => {
  const h = path.join(ROOT, ".harnery");
  mkdirSync(path.join(h, "active"), { recursive: true });
  mkdirSync(path.join(h, "councils"), { recursive: true });
  mkdirSync(path.join(h, "scratch"), { recursive: true });

  const now = new Date();
  const fresh = new Date(now.getTime() - 30_000).toISOString();
  const stale = new Date(now.getTime() - 10 * 60 * 1000).toISOString();

  writeFileSync(
    path.join(h, "active", "abc-fresh.json"),
    JSON.stringify({
      instance_id: "abc-fresh",
      name: "Alpha",
      kind: "session",
      platform: "claude_code",
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

  writeFileSync(
    path.join(h, "active", "broken.json"),
    "{ this is not valid json",
  );

  writeFileSync(
    path.join(h, "councils", "council-foo.json"),
    JSON.stringify({
      schema_version: 2,
      council_id: "council-foo",
      objective: "test objective",
      status: "active",
      created_at: now.toISOString(),
      created_by: "Alpha",
      members: ["Alpha", "Beta"],
      current_round: 1,
      target_doc: "docs/test.md",
    }),
  );

  writeFileSync(
    path.join(h, "events.ndjson"),
    [
      JSON.stringify({
        schema_version: 1,
        event_id: "01EV0",
        event_type: "tool.pre_use",
        ts: "2026-05-27T15:00:00.000Z",
        instance_id: "abc-fresh",
      }),
      JSON.stringify({
        schema_version: 1,
        event_id: "01EV1",
        event_type: "tool.post_use",
        ts: "2026-05-27T15:00:01.000Z",
        instance_id: "abc-fresh",
      }),
      JSON.stringify({
        schema_version: 1,
        event_id: "01EV2",
        event_type: "session.start",
        ts: "2026-05-27T15:00:02.000Z",
        instance_id: "def-stale",
      }),
    ].join("\n"),
  );

  writeFileSync(
    path.join(h, "scratch", "abc-fresh.md"),
    `# Scratchpad: Alpha\nsession_id: abc-fresh\nstarted: 2026-05-27 10:00 AM CDT\nlast_updated: 2026-05-27 10:01 AM CDT\n\n---\n\n## 2026-05-27 10:01 AM CDT · plan\nfirst entry\n\n## 2026-05-27 10:00 AM CDT · note\nsecond entry\n`,
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
  test("readAgents partitions fresh vs stale and includes invalid", () => {
    const snap = reader.readAgents();
    expect(snap.active.map((h: { name: string }) => h.name)).toEqual(["Alpha"]);
    expect(snap.stale.map((h: { name: string }) => h.name)).toEqual(["Beta"]);
    expect(snap.meta.invalid.length).toBe(1);
    expect(snap.meta.invalid[0].file).toBe("broken.json");
  });

  test("readAgents claims flatten files_touched per heartbeat", () => {
    const snap = reader.readAgents();
    const paths = snap.claims.map((c: { path: string }) => c.path).sort();
    expect(paths).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
  });

  test("readAgent returns single heartbeat or null", () => {
    expect(reader.readAgent("abc-fresh")?.name).toBe("Alpha");
    expect(reader.readAgent("not-real")).toBeNull();
  });

  test("readCouncils returns active councils with summary fields", () => {
    const snap = reader.readCouncils();
    expect(snap.active.length).toBe(1);
    expect(snap.active[0].objective).toBe("test objective");
    expect(snap.active[0].members).toEqual(["Alpha", "Beta"]);
  });

  test("readEvents tails the file newest-first with filter support", () => {
    const all = reader.readEvents({ limit: 10 });
    expect(all.rows.length).toBe(3);
    expect(all.rows[0].event_id).toBe("01EV2"); // newest first

    const onlyAlpha = reader.readEvents({ instanceId: "abc-fresh", limit: 10 });
    expect(onlyAlpha.rows.every((r: { instance_id: string }) => r.instance_id === "abc-fresh"))
      .toBe(true);

    const onlyPre = reader.readEvents({ type: "tool.pre_use", limit: 10 });
    expect(onlyPre.rows.every((r: { event_type: string }) => r.event_type === "tool.pre_use"))
      .toBe(true);
  });

  test("readScratch parses entries and inverts to newest-first display", () => {
    const sc = reader.readScratch("abc-fresh");
    expect(sc.exists).toBe(true);
    expect(sc.entries.length).toBe(2);
    // Scratch files are newest-first on disk (appendEntry unshifts the new
    // header to the top), and readScratch preserves that file order. So the
    // top entry (10:01 · plan) is newest and renders first; 10:00 · note is
    // second. See readScratch's "File is newest-first" note.
    expect(sc.entries[0].category).toBe("plan");
    expect(sc.entries[1].category).toBe("note");
  });

  test("readScratch on missing instance returns empty doc", () => {
    const sc = reader.readScratch("not-here");
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
