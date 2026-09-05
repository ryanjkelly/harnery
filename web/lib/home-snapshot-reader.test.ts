import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-routing.ts";
import { __resetCoordRootCache } from "./coord-reader";
import { readHomeSnapshot } from "./home-snapshot-reader";

const roots: string[] = [];
const previousRoot = process.env.HARNERY_COORD_ROOT;

afterEach(() => {
  if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = previousRoot;
  __resetCoordRootCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a populated homepage snapshot survives worker structured cloning", () => {
  const root = mkdtempSync(join(tmpdir(), "home-snapshot-"));
  roots.push(root);
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-home-snapshot",
  });
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected active V3 route");
  expect(
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-start",
      payload: { session_id: "native-home-test", raw: {} },
      adapter: "codex",
      instanceId: "home-test-agent",
    }).state,
  ).toBe("recorded");

  const snapshot = readHomeSnapshot();
  const transferred = structuredClone(snapshot);
  expect(transferred).toEqual(snapshot);
  expect(transferred.snap.active).toHaveLength(1);
  expect(
    transferred.recentEvents.rows.some((event) => event.event_type === "session.started"),
  ).toBe(true);
  for (const agent of transferred.snap.active) {
    expect(transferred.instanceToName[agent.instance_id]).toBe(agent.name);
  }
});
