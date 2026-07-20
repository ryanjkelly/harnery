/**
 * Locks the canonical health.* emission.
 * The writer (heartbeat-writer.ts) is now the single source of truth for heal
 * telemetry across both the live auto-heal and `harn agents heal`, emitting
 * health.pidmap_heal / health.heartbeat_heal into events.ndjson on ACTUAL
 * writes only (drift-guarded / write-only); `harn agents heal-events` + health
 * read these back.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { healHeartbeat, healPidmap } from "../../src/core/agents/state/heartbeat-writer.ts";
import { assignName, recordNameAssumption } from "../../src/core/agents/state/names.ts";

function readHealthEvents(root: string, type: string): Array<Record<string, unknown>> {
  const p = path.join(root, ".harnery", "events.ndjson");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.event_type === type);
}

function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-heal-"));
  mkdirSync(path.join(root, ".harnery", "active"), { recursive: true });
  return root;
}

describe("heartbeat-writer canonical health.* emission", () => {
  test("healHeartbeat emits health.heartbeat_heal on recreate, silent when alive", () => {
    const root = freshRoot();
    const hb = healHeartbeat(root, "owner-x", "owner-x");
    expect(hb).not.toBeNull();
    // A freshly-built heartbeat body carries schema_version: 1.
    expect(hb?.schema_version).toBe(1);
    let evs = readHealthEvents(root, "health.heartbeat_heal");
    expect(evs.length).toBe(1);
    expect(evs[0].instance_id).toBe("owner-x");

    // Already alive → returns existing, emits nothing new.
    healHeartbeat(root, "owner-x", "owner-x");
    evs = readHealthEvents(root, "health.heartbeat_heal");
    expect(evs.length).toBe(1);
  });

  test("healHeartbeat stamps platform from the supplied harness, defaults to claude_code", () => {
    const root = freshRoot();

    // No harness → legacy default preserved (manual `harn agents heal` path).
    const cc = healHeartbeat(root, "owner-cc", "owner-cc");
    expect(cc?.platform).toBe("claude_code");

    // harness="cursor" → platform recreated as cursor, not mislabeled
    // claude_code (the live tool.pre_use heal path for a pruned Cursor agent).
    const cur = healHeartbeat(root, "owner-cur", "owner-cur", "", "cursor");
    expect(cur?.platform).toBe("cursor");

    // harness="codex" → platform codex.
    const cdx = healHeartbeat(root, "owner-cdx", "owner-cdx", "", "codex");
    expect(cdx?.platform).toBe("codex");
  });

  test("healHeartbeat restores an assumed durable persona from append-only name history", () => {
    const root = freshRoot();
    assignName(root, "owner-role", "session");
    recordNameAssumption(root, "owner-role", "Yann", "11111111-1111-4111-8111-111111111111");

    const hb = healHeartbeat(root, "owner-role", "owner-role", "", "codex");
    expect(hb).toMatchObject({
      name: "Yann",
      kind: "session",
      agent_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  test("healPidmap emits health.pidmap_heal on drift only (missing + stale), silent when correct", () => {
    const root = freshRoot();

    // Missing → write + emit reason=missing.
    healPidmap(root, "owner-y", 4242);
    let evs = readHealthEvents(root, "health.pidmap_heal");
    expect(evs.length).toBe(1);
    expect((evs[0].data as Record<string, unknown>).reason).toBe("missing");

    // Already correct → drift guard skips the write + emit.
    healPidmap(root, "owner-y", 4242);
    evs = readHealthEvents(root, "health.pidmap_heal");
    expect(evs.length).toBe(1);

    // Different owner on the same pid → stale heal, emits reason=stale.
    healPidmap(root, "owner-z", 4242);
    evs = readHealthEvents(root, "health.pidmap_heal");
    expect(evs.length).toBe(2);
    expect(evs.some((e) => (e.data as Record<string, unknown>).reason === "stale")).toBe(true);
  });
});
