import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  endSession,
  pingAgent,
  releaseClaim,
  resolveOperatorMutationOwner,
  safeOwnerId,
} from "./coord-writer";
import { __resetCoordRootCache } from "./coord-reader";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap";
import { sha256V3 } from "../../src/core/events/v3/canonical";
import { recordLiveHookSignalV3, resolveLiveEventLedgerRouteV3 } from "../../src/core/events/v3/live-routing";
import { peerInbox } from "../../src/core/inbox/peer-messages";

describe("web coordination writer instance IDs", () => {
  test("web pings use the same bound instance inbox and never append a peer journal", () => {
    const root = mkdtempSync(path.join(tmpdir(), "harnery-web-inbox-"));
    const previousRoot = process.env.HARNERY_COORD_ROOT;
    const previousOverride = process.env.HARNERY_COORD_ROOT_OVERRIDE;
    try {
      mkdirSync(path.join(root, ".harnery"));
      initializeEventLedgerV3({ coordRoot: root, harneryBuild: "fixture", hostBuild: "fixture", configDigest: sha256V3("fixture"), approvalRecordId: "web-inbox-fixture" });
      const route = resolveLiveEventLedgerRouteV3(root);
      if (route.state !== "v3") throw new Error("fixture requires V3");
      recordLiveHookSignalV3({ coordRoot: root, route, eventName: "session-start", payload: { session_id: "web-recipient", raw: {} }, adapter: "codex", instanceId: "web-recipient" });
      writeFileSync(path.join(root, ".harnery/.name-history"), JSON.stringify({ instance_id: "web-recipient", name: "Recipient", kind: "session", ts: new Date().toISOString() }) + "\n");
      process.env.HARNERY_COORD_ROOT = root; __resetCoordRootCache();
      const result = pingAgent("web-recipient", "private web feedback");
      expect(result).toMatchObject({ ok: true, target_instance: "web-recipient", state: "written-live", bytes: 20 });
      expect(peerInbox(root).pending("web-recipient")).toMatchObject([{ message_id: result.message_id, sender_instance_id: null, sender_display_name: "Operator", body: "private web feedback" }]);
      expect(existsSync(path.join(root, ".harnery/journal/web-recipient.md"))).toBe(false);
      expect(pingAgent("unknown-recipient", "do not create a target").ok).toBe(false);
      expect(peerInbox(root).pending("unknown-recipient")).toEqual([]);
    } finally {
      if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT; else process.env.HARNERY_COORD_ROOT = previousRoot;
      if (previousOverride === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE; else process.env.HARNERY_COORD_ROOT_OVERRIDE = previousOverride;
      __resetCoordRootCache(); rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects path traversal at every mutation boundary", async () => {
    const attack = "../../outside";
    expect(safeOwnerId(attack)).toBe(false);
    expect(await releaseClaim(attack, "src/index.ts")).toMatchObject({
      ok: false,
      error: "invalid instance_id",
    });
    expect(pingAgent(attack, "hello")).toMatchObject({
      ok: false,
      error: "invalid instance_id",
    });
    expect(await endSession(attack)).toMatchObject({ ok: false, error: "invalid instance_id" });
  });

  test("preserves a canonical owner when no validated native cache alias exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "harnery-operator-owner-"));
    try {
      expect(resolveOperatorMutationOwner("inst_fixture-owner", root)).toBe("inst_fixture-owner");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps a canonical owner through a generation-bound native cache alias", () => {
    const root = mkdtempSync(path.join(tmpdir(), "harnery-operator-owner-"));
    try {
      const active = path.join(root, ".harnery", "active");
      mkdirSync(active, { recursive: true });
      writeFileSync(
        path.join(active, "fixture-owner.json"),
        JSON.stringify({
          schema_version: 2,
          instance_id: "fixture-owner",
          v3_instance_id: "inst_fixture-owner",
          v3_generation_id: "gen_fixture",
        }),
      );
      expect(resolveOperatorMutationOwner("inst_fixture-owner", root)).toBe("fixture-owner");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
