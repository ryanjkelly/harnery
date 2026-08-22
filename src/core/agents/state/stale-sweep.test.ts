import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../events/v3/live-routing.ts";
import { readLedgerV3 } from "../../events/v3/reader.ts";
import { eventV3Paths } from "../../events/v3/writer.ts";
import { staleSweep } from "./stale-sweep.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("staleSweep V3 audit fallback", () => {
  test("removes a terminal generation cache without appending after its terminal", () => {
    const root = fixtureRoot();
    seedV3Session(root, "terminal", { adapter: "codex", sessionId: "terminal-session" });
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error(`fixture_v3_route:${route.reason}`);
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "session-end",
        adapter: "codex",
        instanceId: "terminal",
        payload: { session_id: "terminal-session", raw: {} },
      }).state,
    ).toBe("recorded");
    const before = readLedgerV3(root).events.map(({ event }) => event.event_type);
    const heartbeat = writeStaleHeartbeat(root, "terminal", "terminal-session", "codex");

    expect(staleSweep(root).heartbeatsRemoved).toEqual(["terminal.json"]);
    expect(existsSync(heartbeat)).toBeFalse();
    expect(readLedgerV3(root).events.map(({ event }) => event.event_type)).toEqual(before);
    expect(readSweepDiagnostics(root)).toContainEqual(
      expect.objectContaining({
        category: "heartbeat_sweep_unrecorded",
        instance_id: "terminal",
        reason: expect.stringContaining("hook_generation_not_joinable"),
      }),
    );
  });

  test("removes a stale cache with missing producer state and preserves the failed audit", () => {
    const root = fixtureRoot();
    const heartbeat = writeStaleHeartbeat(root, "missing", "missing-session", "cursor");

    expect(staleSweep(root).heartbeatsRemoved).toEqual(["missing.json"]);
    expect(existsSync(heartbeat)).toBeFalse();
    expect(
      readLedgerV3(root).events.some(
        ({ event }) => event.event_type === "lifecycle.sweep_observed",
      ),
    ).toBeFalse();
    expect(readSweepDiagnostics(root)).toContainEqual(
      expect.objectContaining({
        category: "heartbeat_sweep_unrecorded",
        instance_id: "missing",
        reason: expect.stringContaining("hook_generation_not_joinable"),
      }),
    );
  });

  test("records a provisional lifecycle observation for a joinable stale generation", () => {
    const root = fixtureRoot();
    seedV3Session(root, "live", { adapter: "claude-code", sessionId: "live-session" });
    const heartbeat = writeStaleHeartbeat(root, "live", "live-session", "claude-code");

    expect(staleSweep(root).heartbeatsRemoved).toEqual(["live.json"]);
    expect(existsSync(heartbeat)).toBeFalse();
    const swept = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "lifecycle.sweep_observed");
    expect(swept).toHaveLength(1);
    expect(swept[0]?.payload).toMatchObject({
      observation: "stale_heartbeat",
      provisional: true,
      subject_instance_id: "inst_live",
    });
    expect(readSweepDiagnostics(root)).toEqual([]);
  });

  test("keeps a fresh malformed cache row without attempting an audit", () => {
    const root = fixtureRoot();
    const heartbeat = join(root, ".harnery", "active", "fresh-malformed.json");
    mkdirSync(dirname(heartbeat), { recursive: true });
    writeFileSync(heartbeat, "{", "utf8");

    expect(staleSweep(root).heartbeatsRemoved).toEqual([]);
    expect(existsSync(heartbeat)).toBeTrue();
    expect(readSweepDiagnostics(root)).toEqual([]);
  });

  test("keeps a stale cache when neither audit record can be persisted", () => {
    const root = fixtureRoot();
    const heartbeat = writeStaleHeartbeat(root, "blocked", "blocked-session", "codex");
    const diagnostics = eventV3Paths(root).diagnostics;
    rmSync(diagnostics, { recursive: true, force: true });
    writeFileSync(diagnostics, "not a directory", "utf8");

    expect(staleSweep(root).heartbeatsRemoved).toEqual([]);
    expect(existsSync(heartbeat)).toBeTrue();
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-stale-sweep-v3-"));
  roots.push(root);
  initializeV3Fixture(root);
  return root;
}

function writeStaleHeartbeat(
  root: string,
  instanceId: string,
  sessionId: string,
  platform: "claude-code" | "cursor" | "codex",
): string {
  const path = join(root, ".harnery", "active", `${instanceId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      schema_version: 2,
      instance_id: instanceId,
      session_id: sessionId,
      platform,
      started_at: "2020-01-01T00:00:00.000Z",
      last_heartbeat: "2020-01-01T00:00:00.000Z",
      files_touched: [],
    })}\n`,
    "utf8",
  );
  return path;
}

function readSweepDiagnostics(root: string): Array<Record<string, unknown>> {
  const diagnostics = eventV3Paths(root).diagnostics;
  if (!existsSync(diagnostics)) return [];
  return readdirSync(diagnostics)
    .filter((name) => name.startsWith("heartbeat_sweep_unrecorded-") && name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(diagnostics, name), "utf8")));
}
