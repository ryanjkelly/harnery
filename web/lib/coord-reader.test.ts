import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-routing.ts";
import {
  __resetCoordRootCache,
  __resetNameHistoryCache,
  classifyAgentLedgerStateV3,
  historyNameForInstance,
  readAgents,
  readCachedAgentsForCodec,
  readEvents,
} from "./coord-reader.ts";

const roots: string[] = [];
const previousRoot = process.env.HARNERY_COORD_ROOT;

afterEach(() => {
  if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = previousRoot;
  __resetCoordRootCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("V3 web coordination reader", () => {
  test("distinguishes ending, recovery-required, and terminal generations", () => {
    expect(
      classifyAgentLedgerStateV3({
        terminal: false,
        pending_finalization: true,
        open_span_count: 2,
        turn_open: false,
      }),
    ).toBe("ending");
    expect(
      classifyAgentLedgerStateV3({
        terminal: false,
        pending_finalization: false,
        open_span_count: 2,
        turn_open: false,
      }),
    ).toBe("recovery-required");
    expect(
      classifyAgentLedgerStateV3({
        terminal: true,
        pending_finalization: false,
        open_span_count: 0,
        turn_open: false,
      }),
    ).toBe("terminal");
  });

  test("projects agents and events only from an initialized V3 ledger", () => {
    const root = freshRoot();
    process.env.HARNERY_COORD_ROOT = root;
    __resetCoordRootCache();

    expect(readEvents().rows).toEqual([]);
    initializeEventLedgerV3({
      coordRoot: root,
      harneryBuild: "fixture",
      hostBuild: "fixture",
      configDigest: sha256V3("config"),
      approvalRecordId: "test-web-reader",
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    });
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected active V3 route");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "session-start",
        payload: { session_id: "native-web-test", raw: {} },
        adapter: "codex",
        instanceId: "web-test-agent",
      }).state,
    ).toBe("recorded");

    const events = readEvents({ type: "session.started" });
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.schema_version).toBe(3);
    expect(events.meta.path).toContain("ledgers/v3/active.ndjson");
    const agents = readAgents();
    expect(agents.active).toHaveLength(1);
    expect(agents.active[0]?.platform).toBe("codex");
  });

  test("Codec caches recover a history name instead of a blank or UUID heading", () => {
    const root = freshRoot();
    process.env.HARNERY_COORD_ROOT = root;
    __resetCoordRootCache();
    const native = "f60993f5-5a32-4d5a-bd8f-825bca29167e";
    mkdirSync(join(root, ".harnery", "active"), { recursive: true });
    writeFileSync(
      join(root, ".harnery", ".name-history"),
      `${JSON.stringify({
        instance_id: native,
        name: "Kestrel",
        kind: "session",
        source: "pool",
        ts: "2026-09-01T06:48:00Z",
      })}\n`,
    );
    writeFileSync(
      join(root, ".harnery", "active", `${native}.json`),
      JSON.stringify({
        schema_version: 2,
        instance_id: native,
        v3_instance_id: `inst_${native}`,
        v3_generation_id: "gen_fixture",
        name: "",
        last_heartbeat: new Date().toISOString(),
        files_touched: [],
        activity: "working",
        task_state: "active",
        task: "Wrap session",
      }),
    );

    const snapshot = readCachedAgentsForCodec();
    expect(snapshot.active).toHaveLength(1);
    expect(snapshot.active[0]?.name).toBe("Kestrel");
    expect(snapshot.active[0]?.task).toBe("Wrap session");
  });
});

describe("name-history index", () => {
  test("the newest row wins across id forms and a rewrite refreshes the index", () => {
    const root = freshRoot();
    process.env.HARNERY_COORD_ROOT = root;
    __resetCoordRootCache();
    __resetNameHistoryCache();
    const native = "f60993f5-5a32-4d5a-bd8f-825bca29167e";
    const historyPath = join(root, ".harnery", ".name-history");
    const row = (instance_id: string, name: string) =>
      `${JSON.stringify({ instance_id, name, kind: "session", source: "pool", ts: "t" })}\n`;
    writeFileSync(historyPath, row(native, "agent-Kestrel") + row(`inst_${native}`, "Wren"));
    expect(historyNameForInstance(native)).toBe("Wren");
    expect(historyNameForInstance(`inst_${native}`)).toBe("Wren");
    expect(historyNameForInstance("00000000-0000-4000-8000-000000000000")).toBeUndefined();

    // Same size, later mtime: the index must notice the rewrite.
    const later = new Date(Date.now() + 5_000);
    writeFileSync(historyPath, row(`inst_${native}`, "Wren") + row(native, "agent-Kestrel"));
    utimesSync(historyPath, later, later);
    expect(historyNameForInstance(native)).toBe("Kestrel");
  });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-web-v3-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  return root;
}
