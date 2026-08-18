import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV2 } from "../../src/core/events/v2/bootstrap.ts";
import { sha256V2 } from "../../src/core/events/v2/canonical.ts";
import {
  recordLiveHookSignalV2,
  resolveLiveEventLedgerRouteV2,
} from "../../src/core/events/v2/live-routing.ts";
import {
  __resetCoordRootCache,
  classifyAgentLedgerStateV2,
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

describe("V2 web coordination reader", () => {
  test("distinguishes ending, recovery-required, and terminal generations", () => {
    expect(
      classifyAgentLedgerStateV2({
        terminal: false,
        pending_finalization: true,
        open_span_count: 2,
        turn_open: false,
      }),
    ).toBe("ending");
    expect(
      classifyAgentLedgerStateV2({
        terminal: false,
        pending_finalization: false,
        open_span_count: 2,
        turn_open: false,
      }),
    ).toBe("recovery-required");
    expect(
      classifyAgentLedgerStateV2({
        terminal: true,
        pending_finalization: false,
        open_span_count: 0,
        turn_open: false,
      }),
    ).toBe("terminal");
  });

  test("projects agents and events only from an initialized V2 ledger", () => {
    const root = freshRoot();
    process.env.HARNERY_COORD_ROOT = root;
    __resetCoordRootCache();

    expect(readEvents().rows).toEqual([]);
    initializeEventLedgerV2({
      coordRoot: root,
      harneryBuild: "fixture",
      hostBuild: "fixture",
      configDigest: sha256V2("config"),
      approvalRecordId: "test-web-reader",
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    });
    const route = resolveLiveEventLedgerRouteV2(root);
    if (route.state !== "v2") throw new Error("expected active V2 route");
    expect(
      recordLiveHookSignalV2({
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
    expect(events.rows[0]?.schema_version).toBe(2);
    expect(events.meta.path).toContain("ledgers/v2/active.ndjson");
    const agents = readAgents();
    expect(agents.active).toHaveLength(1);
    expect(agents.active[0]?.coord_source).toBe("ledger");
    expect(agents.active[0]?.platform).toBe("codex");
  });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-web-v2-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  return root;
}
