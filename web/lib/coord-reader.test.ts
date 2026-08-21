import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  classifyAgentLedgerStateV3,
  readAgents,
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
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-web-v3-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  return root;
}
