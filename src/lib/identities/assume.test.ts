import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { failingLockFileSeam } from "../../../tests/helpers/lock-file-seam.ts";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { ensureLiveCoordinationHeartbeat } from "../../core/agents/state/live-coordination-writer.ts";
import { resolveName } from "../../core/agents/state/names.ts";
import { initializeEventLedgerV3 } from "../../core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../core/events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../core/events/v3/live-routing.ts";
import { readLedgerV3 } from "../../core/events/v3/reader.ts";
import { acquireAssumeLock, assumeIdentity, IdentityAssumeError } from "./assume.ts";

describe("assumeIdentity", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-assume-"));
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    initializeLedger(root);
    seedHeartbeat(root, "session-new", "Anna");
  });

  afterEach(() => {
    removeDir(root);
  });

  test("binds the heartbeat, append-only name history, persona registry, and event ledger", () => {
    const result = assumeIdentity(root, "session-new", "agent-Yann");
    expect(result.changed).toBe(true);
    expect(result.previous_name).toBe("Anna");
    expect(result.name).toBe("Yann");
    expect(result.identity_created).toBe(true);
    expect(result.event_id).toBeTruthy();
    expect(result.reclaimed_instance_id).toBeNull();

    const hb = JSON.parse(
      readFileSync(path.join(root, ".harnery", "active", "session-new.json"), "utf8"),
    );
    expect(hb.name).toBe("Yann");
    expect(hb.agent_id).toBe(result.agent_id);
    expect(resolveName(root, "session-new")).toEqual({
      name: "Yann",
      kind: "session",
      agent_id: result.agent_id,
    });

    const personaFiles = readdirSync(path.join(root, ".harnery", "identities"));
    expect(personaFiles).toEqual([`${result.agent_id}.json`]);
    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(events.some((event) => event.event_type === "coord.identity_attested")).toBe(true);
  });

  test("is idempotent after the session already owns the durable persona", () => {
    assumeIdentity(root, "session-new", "Yann");
    const historyPath = path.join(root, ".harnery", ".name-history");
    const eventsBefore = readLedgerV3(root).events.length;
    const historyBefore = readFileSync(historyPath, "utf8");

    const retry = assumeIdentity(root, "session-new", "Yann");
    expect(retry.changed).toBe(false);
    expect(retry.event_id).toBeNull();
    expect(readLedgerV3(root).events).toHaveLength(eventsBefore);
    expect(readFileSync(historyPath, "utf8")).toBe(historyBefore);
  });

  test("refuses a namesake whose adapter process is still alive", () => {
    seedHeartbeat(root, "session-old", "Yann");
    // Anchor the old session to THIS live test process so the reclaim probe
    // treats it as genuinely occupied.
    writeFileSync(
      path.join(root, ".harnery", "pid-map", String(process.pid)),
      "session-old\tcodex",
    );
    let caught: unknown;
    try {
      assumeIdentity(root, "session-new", "Yann");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdentityAssumeError);
    expect((caught as IdentityAssumeError).code).toBe("identity_in_use");
    expect(existsSync(path.join(root, ".harnery", "identities"))).toBe(false);
    expect(resolveName(root, "session-new")?.name).toBe("Anna");
    expect(existsSync(path.join(root, ".harnery", "active", "session-old.json"))).toBe(true);
  });

  test("reclaims a fresh namesake whose pid-map process is dead", () => {
    seedHeartbeat(root, "session-old", "Yann");
    writeFileSync(path.join(root, ".harnery", "pid-map", "999999999"), "session-old\tcodex");

    const result = assumeIdentity(root, "session-new", "Yann");
    expect(result.name).toBe("Yann");
    expect(result.reclaimed_instance_id).toBe("session-old");
    expect(existsSync(path.join(root, ".harnery", "active", "session-old.json"))).toBe(false);
    expect(existsSync(path.join(root, ".harnery", "pid-map", "999999999"))).toBe(false);

    const events = readLedgerV3(root).events.map(({ event }) => event);
    expect(events.some((event) => event.event_type === "lifecycle.sweep_observed")).toBe(true);
  });

  test("reclaims a fresh namesake with no pid-map rows at all", () => {
    seedHeartbeat(root, "session-old", "Renee");
    const result = assumeIdentity(root, "session-new", "Renee");
    expect(result.name).toBe("Renee");
    expect(result.reclaimed_instance_id).toBe("session-old");
    expect(existsSync(path.join(root, ".harnery", "active", "session-old.json"))).toBe(false);
  });

  test("ignores a forged stale cache timestamp and follows V3 liveness", () => {
    seedHeartbeat(root, "session-old", "Beatrice", Date.now() - 20 * 60_000);
    const result = assumeIdentity(root, "session-new", "Beatrice");
    expect(result.name).toBe("Beatrice");
    expect(result.reclaimed_instance_id).toBe("session-old");
  });
});

function seedHeartbeat(root: string, instanceId: string, name: string, nowMs = Date.now()): void {
  const ts = new Date(nowMs).toISOString();
  const historyPath = path.join(root, ".harnery", ".name-history");
  const priorHistory = existsSync(historyPath) ? readFileSync(historyPath, "utf8") : "";
  writeFileSync(
    historyPath,
    `${priorHistory}${JSON.stringify({ instance_id: instanceId, name, kind: "session", source: "pool", ts })}\n`,
  );
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected V3 route");
  recordLiveHookSignalV3({
    coordRoot: root,
    route,
    eventName: "session-start",
    payload: { session_id: instanceId, raw: {} },
    adapter: "codex",
    instanceId,
  });
  const cache = ensureLiveCoordinationHeartbeat(root, instanceId, instanceId, "codex");
  if (!cache) throw new Error("expected V3 cache");
  writeFileSync(
    path.join(root, ".harnery", "active", `${instanceId}.json`),
    JSON.stringify({
      ...cache,
      schema_version: 2,
      name,
      kind: "session",
      agent_id: instanceId,
      started_at: ts,
      last_heartbeat: ts,
    }),
  );
}

function initializeLedger(root: string): void {
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-identity-assume",
  });
}

describe("assumeIdentity fork-ancestor guard", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-assume-fork-"));
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    initializeLedger(root);
    seedHeartbeat(root, "fork-1", "Maya");
    // Lineage: fork-1 was branched from parent-1 (agent-Hazel), which has
    // since exited (no heartbeat), the exact hole liveness checks can't see.
    writeFileSync(
      path.join(root, ".harnery", ".name-history"),
      `${[
        JSON.stringify({
          instance_id: "parent-1",
          name: "Hazel",
          kind: "session",
          source: "pool",
          ts: "2026-01-01T00:00:00Z",
        }),
        JSON.stringify({
          instance_id: "fork-1",
          name: "Maya",
          kind: "session",
          source: "pool",
          forked_from: "parent-1",
          ts: "2026-01-01T00:01:00Z",
        }),
      ].join("\n")}\n`,
    );
  });

  afterEach(() => {
    removeDir(root);
  });

  test("refuses assuming a fork ancestor even when nobody holds the name", () => {
    expect(() => assumeIdentity(root, "fork-1", "Hazel")).toThrow(IdentityAssumeError);
    try {
      assumeIdentity(root, "fork-1", "agent-Hazel");
      throw new Error("expected identity_is_ancestor");
    } catch (error) {
      expect((error as IdentityAssumeError).code).toBe("identity_is_ancestor");
      expect((error as IdentityAssumeError).message).toContain("parent-1");
      expect((error as IdentityAssumeError).message).toContain("--force-ancestor");
    }
  });

  test("--force-ancestor deliberately succeeds the exited ancestor", () => {
    const result = assumeIdentity(root, "fork-1", "Hazel", { forceAncestor: true });
    expect(result.changed).toBe(true);
    expect(result.name).toBe("Hazel");
  });

  test("non-ancestor personas are unaffected by the guard", () => {
    const result = assumeIdentity(root, "fork-1", "Willow");
    expect(result.changed).toBe(true);
    expect(result.name).toBe("Willow");
  });
});

describe("acquireAssumeLock", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-assume-lock-"));
  });

  afterEach(() => {
    removeDir(root);
  });

  test("retries after EPERM on Windows while a peer releases the lock", () => {
    const seam = failingLockFileSeam("EPERM", "win32", 1);
    const release = acquireAssumeLock(root, seam);
    expect(seam.calls).toBe(2);
    expect(existsSync(path.join(root, ".harnery", "identity-assume.lock"))).toBe(true);
    release();
    expect(existsSync(path.join(root, ".harnery", "identity-assume.lock"))).toBe(false);
  });

  test("reports busy, not EPERM, when Windows keeps refusing the create", () => {
    const seam = failingLockFileSeam("EPERM", "win32");
    let caught: unknown;
    try {
      acquireAssumeLock(root, seam);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IdentityAssumeError);
    expect((caught as IdentityAssumeError).code).toBe("identity_busy");
  });

  test("throws EPERM on other platforms", () => {
    const seam = failingLockFileSeam("EPERM", "linux");
    expect(() => acquireAssumeLock(root, seam)).toThrow("EPERM");
    expect(seam.calls).toBe(1);
  });
});
