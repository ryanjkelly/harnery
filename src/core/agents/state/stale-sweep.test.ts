import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { staleSweep } from "./stale-sweep.ts";

const FRESHNESS = 600; // matches DEFAULT_FRESHNESS_SECS

describe("staleSweep", () => {
  let root: string;
  let activeDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "harn-sweep-"));
    activeDir = join(root, ".harnery", "active");
    mkdirSync(activeDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function nowIso(offsetSecs = 0): string {
    return new Date(Date.now() + offsetSecs * 1000).toISOString();
  }
  function writeHb(id: string, body: string): string {
    const p = join(activeDir, `${id}.json`);
    writeFileSync(p, body);
    return p;
  }
  function setOldMtime(path: string): void {
    const old = new Date(Date.now() - (FRESHNESS + 120) * 1000);
    utimesSync(path, old, old);
  }
  function exists(id: string): boolean {
    return existsSync(join(activeDir, `${id}.json`));
  }
  function sweptEvents(): Array<{ instance_id: string; data: { reason: string } }> {
    const p = join(root, ".harnery", "events.ndjson");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.event_type === "health.heartbeat_swept");
  }

  test("keeps a fresh, valid heartbeat", () => {
    writeHb("fresh", JSON.stringify({ instance_id: "fresh", last_heartbeat: nowIso() }));
    const r = staleSweep(root);
    expect(r.heartbeatsRemoved).toEqual([]);
    expect(exists("fresh")).toBe(true);
    expect(sweptEvents()).toEqual([]);
  });

  test("reaps a stale (old last_heartbeat) heartbeat and emits swept:stale", () => {
    writeHb(
      "stale",
      JSON.stringify({ instance_id: "stale", last_heartbeat: nowIso(-(FRESHNESS + 60)) }),
    );
    const r = staleSweep(root);
    expect(r.heartbeatsRemoved).toEqual(["stale.json"]);
    expect(exists("stale")).toBe(false);
    const swept = sweptEvents();
    expect(swept).toHaveLength(1);
    expect(swept[0]!.data.reason).toBe("stale");
    expect(swept[0]!.instance_id).toBe("stale");
  });

  test("DOES NOT delete a fresh-mtime unparseable heartbeat (the footgun fix)", () => {
    // Simulates a partial/transient read (e.g. mid-write). The file was just
    // written, so a live agent owns it; sweep must not reap it.
    writeHb("freshbad", '{"instance_id":"freshbad","last_heartbeat":"');
    const r = staleSweep(root);
    expect(r.heartbeatsRemoved).toEqual([]);
    expect(exists("freshbad")).toBe(true);
    expect(sweptEvents()).toEqual([]);
  });

  test("reaps an OLD-mtime unparseable heartbeat and emits swept:unparseable", () => {
    const p = writeHb("oldbad", "{ this is not json");
    setOldMtime(p);
    const r = staleSweep(root);
    expect(r.heartbeatsRemoved).toEqual(["oldbad.json"]);
    expect(exists("oldbad")).toBe(false);
    const swept = sweptEvents();
    expect(swept).toHaveLength(1);
    expect(swept[0]!.data.reason).toBe("unparseable");
  });

  test("keeps a fresh-mtime heartbeat missing last_heartbeat; reaps it when mtime is old", () => {
    // fresh mtime, no last_heartbeat → keep
    writeHb("noheart", JSON.stringify({ instance_id: "noheart" }));
    expect(staleSweep(root).heartbeatsRemoved).toEqual([]);
    expect(exists("noheart")).toBe(true);

    // make it mtime-old → now reaped with reason=missing_ts
    setOldMtime(join(activeDir, "noheart.json"));
    const r = staleSweep(root);
    expect(r.heartbeatsRemoved).toEqual(["noheart.json"]);
    expect(sweptEvents().some((e) => e.data.reason === "missing_ts")).toBe(true);
  });
});
