import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-routing.ts";

const HARN = join(resolve(import.meta.dir, "../.."), "bin", "harn");
const OWNER = "turn-elapsed-fixture";
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("harn agents status turn row", () => {
  test("carries the turn row on a session's first turn", () => {
    const root = sandbox({ prompt: true });

    const human = harn(root, ["agents", "status", "--session-id", OWNER]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("turn");
    expect(human.stdout).toMatch(/turn\s+\d+s/);

    const json = harn(root, ["agents", "status", "--json", "--session-id", OWNER]);
    expect(json.status).toBe(0);
    const data = JSON.parse(json.stdout) as {
      turn_elapsed_secs: number | null;
      turn_complete: boolean | null;
    };
    expect(data.turn_elapsed_secs).toBeGreaterThanOrEqual(0);
    expect(data.turn_complete).toBe(false);
  }, 15_000);

  test("renders no turn row for a session that never started a turn", () => {
    const root = sandbox({ prompt: false });

    const human = harn(root, ["agents", "status", "--session-id", OWNER]);
    expect(human.status).toBe(0);
    expect(human.stdout).not.toMatch(/^\W*turn\s/m);

    const json = harn(root, ["agents", "status", "--json", "--session-id", OWNER]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      turn_elapsed_secs: null,
      turn_complete: null,
    });
  }, 15_000);
});

function sandbox(options: { prompt: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "harn-turn-elapsed-status-"));
  sandboxes.push(root);
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(root, ".harnery", "active", `${OWNER}.json`),
    JSON.stringify({
      instance_id: OWNER,
      session_id: OWNER,
      agent_id: OWNER,
      name: "Fixture",
      model: "fixture",
      platform: "claude-code",
      started_at: now,
      last_heartbeat: now,
      files_touched: [],
    }),
  );
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-turn-elapsed-status",
  });
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected active V3 route");
  const record = (eventName: string, payload: Record<string, unknown>) =>
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName,
      payload: { session_id: OWNER, raw: {}, ...payload },
      adapter: "claude-code",
      instanceId: OWNER,
    });
  record("session-start", {});
  if (options.prompt) {
    record("user-prompt-submit", { turn_id: "turn-elapsed-one", prompt: "inspect" });
  }
  return root;
}

function harn(root: string, args: string[]) {
  return spawnSync("bash", [HARN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HARNERY_COORD_ROOT_OVERRIDE: root,
      HARNERY_AGENT_COORD_OWNER: OWNER,
    },
  });
}
