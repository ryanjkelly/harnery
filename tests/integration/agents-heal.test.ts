import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readHeartbeat } from "../../src/core/agents/state/heartbeat-writer.ts";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import { readEventV3ControlState } from "../../src/core/events/v3/control.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-routing.ts";

const HARNERY_DIR = path.resolve(import.meta.dir, "../..");
const HARN = path.join(HARNERY_DIR, "bin", "harn");
const OWNER = "01a04561-bb62-7432-a885-32005d8aceb7";
const sandboxes: string[] = [];

function makeLedgerSandbox(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-agents-heal-"));
  sandboxes.push(root);
  mkdirSync(path.join(root, ".harnery", "active"), { recursive: true });
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-agents-heal",
  });
  return root;
}

function makeSandbox(): string {
  const root = makeLedgerSandbox();
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected active V3 route");
  const recorded = recordLiveHookSignalV3({
    coordRoot: root,
    route,
    eventName: "session-start",
    payload: { session_id: OWNER, raw: {}, source: "resume" },
    adapter: "codex",
    instanceId: OWNER,
    bridge: "codex-wsl",
  });
  if (recorded.state !== "recorded") throw new Error(`session start was ${recorded.state}`);
  return root;
}

function harn(root: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [HARN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HARNERY_COORD_ROOT_OVERRIDE: root,
      HARNERY_AGENT_COORD_BRIDGE: "codex-wsl",
      HARNERY_AGENT_COORD_SESSION_ID: OWNER,
      CODEX_THREAD_ID: OWNER,
      ...extraEnv,
    },
  });
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const root = sandboxes.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("harn agents heal", () => {
  test("repairs the current Codex session cache with no identity flags", () => {
    const root = makeSandbox();
    const before = readEventV3ControlState(root);

    const result = harn(root, ["agents", "heal", "--json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      rows: [
        {
          instance_id: OWNER,
          action: "repair-coordination-cache",
          outcome: "cache_present",
          after: {
            instance_id: OWNER,
            platform: "codex",
          },
        },
      ],
      meta: {
        kind: "cache",
        automatic: true,
        authority: "event-ledger-v3",
      },
    });
    expect(readHeartbeat(root, OWNER)).toMatchObject({
      instance_id: OWNER,
      platform: "codex",
    });
    const after = readEventV3ControlState(root);
    expect(after.state).toBe(before.state);
    if (before.state !== "active" || after.state !== "active") {
      throw new Error("expected active V3 control before and after repair");
    }
    expect(after.genesis.event.event_id).toBe(before.genesis.event.event_id);
  });

  test("keeps explicit targeted cache repair available", () => {
    const root = makeSandbox();

    const result = harn(root, [
      "agents",
      "heal",
      "--kind",
      "cache",
      "--owner",
      OWNER,
      "--session-id",
      OWNER,
      "--adapter",
      "codex",
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      rows: [{ instance_id: OWNER, outcome: "cache_present" }],
      meta: {
        kind: "cache",
        automatic: false,
        authority: "event-ledger-v3",
      },
    });
  });

  test("fails clearly when no current session identity exists", () => {
    const root = makeLedgerSandbox();

    const result = harn(root, ["agents", "heal"], {
      HARNERY_AGENT_COORD_BRIDGE: "",
      HARNERY_AGENT_COORD_SESSION_ID: "",
      HARNERY_AGENT_COORD_OWNER: "",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
      CURSOR_SESSION_ID: "",
      CURSOR_CONVERSATION_ID: "",
      CLAUDE_CODE_SESSION_ID: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not resolve the current session");
    expect(result.stderr).toContain("pass --owner");
  });
});
