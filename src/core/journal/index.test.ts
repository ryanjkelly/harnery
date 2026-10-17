import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLiveLifecycleChangeV3 } from "../agents/live-authority-v3.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import { EVENT_V3_GENESIS_MANIFEST } from "../events/v3/control.ts";
import { resolveLiveEventLedgerRouteV3 } from "../events/v3/live-routing.ts";
import {
  readHookProducerStateV3,
  recordApprovedSessionEndV3,
  recordHookSignalV3,
} from "../events/v3/producers/recorder.ts";
import { journalPath, parseJournal, sweepOrphanJournals } from "./index.ts";

const roots: string[] = [];
const priorRoot = process.env.HARNERY_COORD_ROOT_OVERRIDE;
afterEach(() => {
  if (priorRoot === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
  else process.env.HARNERY_COORD_ROOT_OVERRIDE = priorRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lifecycleFixture(instanceId: string) {
  const root = mkdtempSync(join(tmpdir(), "harnery-journal-lifecycle-"));
  roots.push(root);
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  mkdirSync(join(root, ".harnery"), { recursive: true });
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("fixture"),
    approvalRecordId: "journal-lifecycle-fixture",
  });
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected fixture V3 route");
  expect(
    recordHookSignalV3({
      coordRoot: root,
      mode: route.mode,
      signal: "session-start",
      payload: { session_id: instanceId, raw: {} },
      adapter: "codex",
      instance_id: `inst_${instanceId}`,
      producer_id: "prd_journal-lifecycle-fixture",
      build_id: route.build_id,
      platform: "linux",
      observed_at: "2026-08-28T22:00:00.000Z",
    }).state,
  ).toBe("recorded");
  const path = journalPath(instanceId);
  writeFileSync(path, "# Journal: agent-Fixture\nretained working note\n");
  return { root, route, path };
}

describe("journal path and parser security", () => {
  test("rejects instance IDs that are not safe basenames", () => {
    expect(() => journalPath("../../outside")).toThrow(/instance_id/);
    expect(() => journalPath("agent/name")).toThrow(/instance_id/);
  });

  test("parses adversarial header whitespace without a polynomial regex", () => {
    const padding = " ".repeat(100_000);
    const doc = parseJournal(
      "fixture.md",
      `# Journal: agent-Test\nsession_id:${padding}fixture\nmachine: local\nstarted: now\nlast_updated: now\n---\n`,
    );
    expect(doc.header.session_id).toBe("fixture");
  });
});

describe("journal authoritative lifecycle sweep", () => {
  test("a stale active generation keeps its journal without a fresh cache", () => {
    const { path } = lifecycleFixture("stale-active");
    expect(sweepOrphanJournals()).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain("retained working note");
  });

  test("task done is still a resumable generation with a retained journal", () => {
    const { root, path } = lifecycleFixture("task-done");
    recordLiveLifecycleChangeV3({
      coordRoot: root,
      owner: "task-done",
      nativeSessionId: "task-done",
      adapter: "codex",
      state: "done",
    });
    expect(sweepOrphanJournals()).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  test("a complete authority view archives an explicitly ended generation", () => {
    const { root, route, path } = lifecycleFixture("ended-owner");
    const state = readHookProducerStateV3(root, "codex", "ended-owner");
    if (!state) throw new Error("fixture producer is missing");
    expect(
      recordApprovedSessionEndV3({
        coordRoot: root,
        mode: route.mode,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        build_id: route.build_id,
        platform: "linux",
        reason: "approved_explicit_end",
        outcome: "succeeded",
        coordination_finalized: true,
      }).state,
    ).toBe("recorded");
    const archived = sweepOrphanJournals();
    expect(archived).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(archived[0]!, "utf8")).toContain("retained working note");
  });

  test("an incomplete or unsafe ledger never turns absence into an archive", () => {
    const { root, path } = lifecycleFixture("unsafe-view");
    const before = readFileSync(path);
    writeFileSync(join(root, EVENT_V3_GENESIS_MANIFEST), "{invalid control fixture");
    expect(sweepOrphanJournals()).toEqual([]);
    expect(readFileSync(path)).toEqual(before);
  });
});
