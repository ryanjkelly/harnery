import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../tests/helpers/event-v3-runtime.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import { reconcileCoordinationV3 } from "./reconcile-coordination-v3.ts";
import { listSessionFinalizationRequestsV3 } from "./session-finalizer-v3.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reconcileCoordinationV3", () => {
  test("one pass sweeps a stale cache row and creates its stale_sweep request", () => {
    const root = fixtureRoot();
    seedV3Session(root, "live", { adapter: "claude-code", sessionId: "live-session" });
    const heartbeat = writeStaleHeartbeat(root, "live", "live-session", "claude-code");

    const result = reconcileCoordinationV3(root);

    // The sweep half ran and reported its count.
    expect(result.swept_heartbeats).toBe(1);
    expect(existsSync(heartbeat)).toBeFalse();

    // The sweeper's observation uses the emitted name. A regression to
    // `stale_sweep` here makes the finalizer branch unreachable from a cold
    // start, which is the bug this composition depends on staying fixed.
    const swept = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.event_type === "lifecycle.sweep_observed");
    const observed = swept.filter((event) => event.payload.observation === "stale_heartbeat");
    expect(observed).toHaveLength(1);
    expect(observed[0]?.payload).toMatchObject({ subject_instance_id: "inst_live" });

    // And the finalizer half consumed it in the SAME pass. This is the whole
    // point of the composition: before it existed, the sweep ran only from its
    // own subcommand and nothing turned its observation into a request.
    expect(result.observed).toBeGreaterThanOrEqual(1);
    const requests = listSessionFinalizationRequestsV3(root);
    const staleSweepRequests = requests.filter((request) => request.trigger === "stale_sweep");
    expect(staleSweepRequests).toHaveLength(1);
    expect(staleSweepRequests[0]).toMatchObject({
      instance_id: "inst_live",
      reason: "policy_stale_sweep",
    });

    // Creating the request writes back a DERIVED echo named after the trigger.
    // No predicate may match that echo, or the finalizer would feed itself.
    const echoes = swept.filter((event) => event.payload.observation === "stale_sweep");
    expect(echoes).toHaveLength(1);
    expect(echoes[0]?.producer.producer_id).toBe("prd_agent-finalizer");

    // Second pass: the echo must not produce another request, and the already
    // deleted cache row must not be swept twice.
    const again = reconcileCoordinationV3(root);
    expect(again.swept_heartbeats).toBe(0);
    expect(
      listSessionFinalizationRequestsV3(root).filter((r) => r.trigger === "stale_sweep"),
    ).toHaveLength(1);
  });

  test("reports zero sweep counts and still reconciles when the cache is clean", () => {
    const root = fixtureRoot();
    seedV3Session(root, "fresh", { adapter: "codex", sessionId: "fresh-session" });

    const result = reconcileCoordinationV3(root);

    expect(result.swept_heartbeats).toBe(0);
    expect(result.swept_pidmaps).toBe(0);
    expect(result.swept_peer_hashes).toBe(0);
    // Finalizer diagnostics are environment-dependent: a clean CI runner has
    // no Codex state database, for example. This assertion owns only the
    // composition contract under test, so it rejects sweep failures without
    // masking legitimate finalizer diagnostics.
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.startsWith("stale_sweep_failed:")),
    ).toBeFalse();
  });

  test("keeps a fresh malformed cache row instead of reaping it", () => {
    const root = fixtureRoot();
    const heartbeat = join(root, ".harnery", "active", "fresh-malformed.json");
    mkdirSync(dirname(heartbeat), { recursive: true });
    writeFileSync(heartbeat, "{", "utf8");

    const result = reconcileCoordinationV3(root);

    expect(result.swept_heartbeats).toBe(0);
    expect(existsSync(heartbeat)).toBeTrue();
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-reconcile-coordination-v3-"));
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
