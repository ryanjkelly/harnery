import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveName } from "../../core/agents/state/names.ts";
import { assumeIdentity, IdentityAssumeError } from "./assume.ts";

describe("assumeIdentity", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-assume-"));
    mkdirSync(path.join(root, ".harnery", "active"), { recursive: true });
    seedHeartbeat(root, "session-new", "Anna");
    writeFileSync(
      path.join(root, ".harnery", ".name-history"),
      `${JSON.stringify({
        instance_id: "session-new",
        name: "Anna",
        kind: "session",
        source: "pool",
        ts: new Date().toISOString(),
      })}\n`,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("binds the heartbeat, append-only name history, persona registry, and event ledger", () => {
    const result = assumeIdentity(root, "session-new", "agent-Yann");
    expect(result.changed).toBe(true);
    expect(result.previous_name).toBe("Anna");
    expect(result.name).toBe("Yann");
    expect(result.identity_created).toBe(true);
    expect(result.event_id).toBeTruthy();

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
    const events = readFileSync(path.join(root, ".harnery", "events.ndjson"), "utf8");
    expect(events).toContain('"event_type":"identity.assumed"');
    expect(events).toContain('"previous_name":"Anna"');
  });

  test("is idempotent after the session already owns the durable persona", () => {
    assumeIdentity(root, "session-new", "Yann");
    const eventPath = path.join(root, ".harnery", "events.ndjson");
    const historyPath = path.join(root, ".harnery", ".name-history");
    const eventsBefore = readFileSync(eventPath, "utf8");
    const historyBefore = readFileSync(historyPath, "utf8");

    const retry = assumeIdentity(root, "session-new", "Yann");
    expect(retry.changed).toBe(false);
    expect(retry.event_id).toBeNull();
    expect(readFileSync(eventPath, "utf8")).toBe(eventsBefore);
    expect(readFileSync(historyPath, "utf8")).toBe(historyBefore);
  });

  test("refuses a fresh namesake before minting or mutating anything", () => {
    seedHeartbeat(root, "session-old", "Yann");
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
  });

  test("ignores a stale namesake under the configured freshness contract", () => {
    seedHeartbeat(root, "session-old", "Beatrice", Date.now() - 20 * 60_000);
    expect(assumeIdentity(root, "session-new", "Beatrice").name).toBe("Beatrice");
  });
});

function seedHeartbeat(root: string, instanceId: string, name: string, nowMs = Date.now()): void {
  const ts = new Date(nowMs).toISOString();
  writeFileSync(
    path.join(root, ".harnery", "active", `${instanceId}.json`),
    JSON.stringify({
      schema_version: 1,
      instance_id: instanceId,
      session_id: instanceId,
      name,
      kind: "session",
      agent_id: instanceId,
      platform: "codex",
      started_at: ts,
      last_heartbeat: ts,
      files_touched: [],
    }),
  );
}
