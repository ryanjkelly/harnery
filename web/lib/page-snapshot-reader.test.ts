import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-routing.ts";
import { __resetCoordRootCache, __resetNameHistoryCache } from "./coord-reader";
import { readCouncilsPageSnapshot, readEventsPageSnapshot } from "./page-snapshot-reader";

const roots: string[] = [];
const previousRoot = process.env.HARNERY_COORD_ROOT;

afterEach(() => {
  if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = previousRoot;
  __resetCoordRootCache();
  __resetNameHistoryCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshLedger() {
  const root = mkdtempSync(join(tmpdir(), "page-snapshots-"));
  roots.push(root);
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
  __resetNameHistoryCache();
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-page-snapshot",
  });
  return root;
}

function identity(root: string, name: string) {
  const dir = join(root, ".harnery", "identities");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({
      schema_version: 1,
      agent_id: `identity-${name}`,
      name,
      aliases: [],
      created_at: new Date().toISOString(),
    }),
  );
}

function eventFixture() {
  const root = freshLedger();
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected active V3 route");
  writeFileSync(
    join(root, ".harnery", ".name-history"),
    ["Kestrel", "Wren"]
      .map((name) => JSON.stringify({ instance_id: `fixture-${name}`, name: `agent-${name}` }))
      .join("\n"),
  );
  for (const name of ["Kestrel", "Wren"]) {
    identity(root, name);
    for (const eventName of ["session-start", "user-prompt-submit"] as const) {
      expect(
        recordLiveHookSignalV3({
          coordRoot: root,
          route,
          eventName,
          payload: { session_id: `native-${name}`, prompt: "Inspect snapshot", raw: {} },
          adapter: "codex",
          instanceId: `fixture-${name}`,
        }).state,
      ).toBe("recorded");
    }
  }
}

test("event snapshots preserve named live summaries and serialize across the worker boundary", () => {
  eventFixture();
  const snapshot = readEventsPageSnapshot({ limit: 100 });
  expect(structuredClone(snapshot)).toEqual(snapshot);
  expect(snapshot.agentNames).toEqual(["Kestrel", "Wren"]);
  expect(snapshot.instanceToName["inst_fixture-Kestrel"]).toBe("Kestrel");
  expect(snapshot.instanceToName["inst_fixture-Wren"]).toBe("Wren");
  expect(snapshot.summaries.kestrel).toMatchObject({
    name: "Kestrel",
    state: "active",
    platform: "codex",
    instance_id: "fixture-Kestrel",
  });
  expect(snapshot.summaries.wren).toMatchObject({ name: "Wren", state: "active" });
  expect(snapshot.allKinds).toContain("session.started");
  expect(snapshot.allKinds).toContain("turn.started");
  expect(snapshot.allKinds).toEqual([...new Set(snapshot.allKinds)].sort());
});

test("event filtering applies before the limit and derives names and kinds from returned rows", () => {
  eventFixture();
  const snapshot = readEventsPageSnapshot({ limit: 1, instanceId: "inst_fixture-Kestrel" });
  expect(snapshot.data.rows).toHaveLength(1);
  expect(snapshot.data.rows[0]?.instance_id).toBe("inst_fixture-Kestrel");
  expect(snapshot.agentNames).toEqual(["Kestrel"]);
  expect(snapshot.allKinds).toEqual([snapshot.data.rows[0]?.event_type]);
  const absent = readEventsPageSnapshot({ limit: 100, instanceId: "inst_missing" });
  expect(absent.data.rows).toEqual([]);
  expect(absent.agentNames).toEqual([]);
  expect(absent.allKinds).toEqual([]);
});

test("council snapshots cover every displayed role across active, closed, and archived councils", () => {
  const root = freshLedger();
  const expectedNames = new Set<string>();
  for (const status of ["active", "closed", "archived"] as const) {
    const dir = join(root, ".harnery", "councils", ...(status === "archived" ? ["archive"] : []));
    const councilId = `council-${status}`;
    const names = ["Creator", "Steward", "Member", "Pending"].map((role) => `${status}${role}`);
    for (const name of names) {
      identity(root, name);
      expectedNames.add(name);
    }
    mkdirSync(join(dir, councilId, "round-1"), { recursive: true });
    writeFileSync(
      join(dir, `${councilId}.json`),
      JSON.stringify({
        council_id: councilId,
        objective: "Review snapshot coverage",
        status,
        created_at: new Date().toISOString(),
        created_by: `agent-${names[0]}`,
        steward: `agent-${names[1]}`,
        members: names.slice(2).map((name) => `agent-${name}`),
        member_ids: [`${status}-member-id`, `${status}-pending-id`],
        current_round: 1,
        round_status: "open",
      }),
    );
    writeFileSync(join(dir, councilId, "round-1", `${status}-member-id.md`), "Contribution");
    if (status === "active") {
      identity(root, "orphan01");
      expectedNames.add("orphan01");
      writeFileSync(
        join(dir, councilId, "round-1", "orphan01-unmapped.md"),
        "Unmapped contributor",
      );
    }
  }
  const snapshot = readCouncilsPageSnapshot();
  expect(structuredClone(snapshot)).toEqual(snapshot);
  expect(snapshot.snap.meta.count).toBe(3);
  for (const status of ["active", "closed", "archived"] as const) {
    expect(snapshot.snap[status]).toHaveLength(1);
    expect(snapshot.snap[status][0]?.pending_in_current_round).toEqual([`agent-${status}Pending`]);
    expect(snapshot.snap[status][0]?.contributors_in_current_round).toContain(
      `agent-${status}Member`,
    );
  }
  expect(snapshot.snap.active[0]?.contributors_in_current_round).toContain("agent-orphan01");
  expect(Object.keys(snapshot.summaries)).toHaveLength(expectedNames.size);
  for (const name of expectedNames) {
    expect(snapshot.summaries[name.toLowerCase()]).toMatchObject({
      name,
      agent_id: `identity-${name}`,
    });
  }
});
