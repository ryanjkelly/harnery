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
import {
  readHookProducerStateV3,
  recordApprovedSessionEndV3,
} from "../../src/core/events/v3/producers/recorder.ts";
import { readLedgerV3 } from "../../src/core/events/v3/reader.ts";

const HARNERY_DIR = path.resolve(import.meta.dir, "../..");
const HARN = path.join(HARNERY_DIR, "bin", "harn");
const OWNER = "01a04561-bb62-7432-a885-32005d8aceb7";
const FOREIGN_OWNER = "019f30c1-4ccd-78bc-9216-40a69a3c7128";
const CURSOR_OWNER = "019f31a2-95d1-7a0f-801f-74db61328160";
const CURSOR_SESSION = "019f31a7-3b0d-76f2-ad2c-3a021c78dbe4";
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

function ledgerEvents(root: string) {
  return readLedgerV3(root).events.map(({ event }) => event);
}

function expectNoInventedTurn(root: string): void {
  expect(ledgerEvents(root).filter((event) => event.event_type.startsWith("turn."))).toEqual([]);
}

function cursorEnv(): Record<string, string> {
  return {
    HARNERY_AGENT_COORD_BRIDGE: "",
    HARNERY_AGENT_COORD_OWNER: "",
    HARNERY_AGENT_COORD_SESSION_ID: "",
    HARNERY_AGENT_COORD_PLATFORM: "cursor",
    CODEX_SESSION_ID: "",
    CODEX_THREAD_ID: "",
    CURSOR_AGENT: "1",
    CURSOR_SESSION_ID: CURSOR_SESSION,
    CURSOR_CONVERSATION_ID: CURSOR_SESSION,
    CLAUDE_CODE_SESSION_ID: "",
  };
}

function claudeEnv(): Record<string, string> {
  return {
    HARNERY_AGENT_COORD_BRIDGE: "",
    HARNERY_AGENT_COORD_OWNER: "",
    HARNERY_AGENT_COORD_SESSION_ID: "",
    HARNERY_AGENT_COORD_PLATFORM: "claude-code",
    CODEX_SESSION_ID: "",
    CODEX_THREAD_ID: "",
    CURSOR_AGENT: "",
    CURSOR_SESSION_ID: "",
    CURSOR_CONVERSATION_ID: "",
    CLAUDE_CODE_SESSION_ID: OWNER,
  };
}

function endSession(root: string, adapter: "codex" | "cursor", owner = OWNER): string {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected active V3 route");
  const state = readHookProducerStateV3(root, adapter, owner);
  if (!state) throw new Error("expected hook producer state");
  const result = recordApprovedSessionEndV3({
    coordRoot: root,
    mode: route.mode,
    instance_id: state.instance_id,
    generation_id: state.generation_id,
    build_id: route.build_id,
    platform: "linux",
    reason: "approved_explicit_end",
    outcome: "succeeded",
    coordination_finalized: true,
  });
  if (result.state !== "recorded") throw new Error(`session end was ${result.state}`);
  return state.generation_id;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const root = sandboxes.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("harn agents heal", () => {
  test("onboards a fresh forwarded Codex identity once, repairs its cache, and passes whoami", () => {
    const root = makeLedgerSandbox();
    expect(readHookProducerStateV3(root, "codex", OWNER)).toBeUndefined();
    expect(readHeartbeat(root, OWNER)).toBeNull();

    const first = harn(root, ["agents", "heal", "--json"]);

    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      rows: [
        {
          instance_id: OWNER,
          action: "repair-coordination-cache",
          outcome: "cache_present",
          after: { instance_id: OWNER, platform: "codex" },
        },
      ],
      meta: {
        kind: "cache",
        automatic: true,
        authority: "event-ledger-v3",
        adapter: "codex",
        bootstrap: "created",
      },
    });
    const firstState = readHookProducerStateV3(root, "codex", OWNER);
    if (!firstState) throw new Error("heal did not onboard the Codex generation");
    const firstCache = readHeartbeat(root, OWNER);
    expect(firstCache).toMatchObject({
      instance_id: OWNER,
      platform: "codex",
      v3_generation_id: firstState.generation_id,
    });
    expect(
      ledgerEvents(root).filter((event) => event.event_type === "session.started"),
    ).toHaveLength(1);
    expectNoInventedTurn(root);

    const whoami = harn(root, ["agents", "whoami", "--json"]);
    expect(whoami.status).toBe(0);
    expect(JSON.parse(whoami.stdout)).toMatchObject({
      instance_id: OWNER,
      platform: "codex",
      resolution_source: "session_env",
    });

    const repeated = harn(root, ["agents", "heal", "--json"]);

    expect(repeated.status).toBe(0);
    const repeatedState = readHookProducerStateV3(root, "codex", OWNER);
    const repeatedCache = readHeartbeat(root, OWNER);
    expect(repeatedState?.generation_id).toBe(firstState.generation_id);
    expect(repeatedCache?.v3_generation_id).toBe(firstCache?.v3_generation_id);
    expect(
      ledgerEvents(root).filter((event) => event.event_type === "session.started"),
    ).toHaveLength(1);
    expectNoInventedTurn(root);
  });

  test("onboards a fresh Claude Code identity from its native session environment", () => {
    const root = makeLedgerSandbox();

    const beforeHeal = harn(root, ["agents", "whoami", "--json"], claudeEnv());
    expect(beforeHeal.status).toBe(1);
    expect(readHookProducerStateV3(root, "claude-code", OWNER)).toBeUndefined();
    expect(readHeartbeat(root, OWNER)).toBeNull();

    const result = harn(root, ["agents", "heal", "--json"], claudeEnv());

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      rows: [
        {
          instance_id: OWNER,
          outcome: "cache_present",
          after: { instance_id: OWNER, platform: "claude-code" },
        },
      ],
      meta: { automatic: true, adapter: "claude-code", bootstrap: "created" },
    });
    expect(readHookProducerStateV3(root, "claude-code", OWNER)).toBeDefined();
    expect(readHeartbeat(root, OWNER)).toMatchObject({
      instance_id: OWNER,
      platform: "claude-code",
    });
    expect(
      ledgerEvents(root).filter((event) => event.event_type === "session.started"),
    ).toHaveLength(1);
    expectNoInventedTurn(root);
  });

  test("fresh Cursor identity outranks an unrelated active singleton during implicit heal", () => {
    const root = makeSandbox();
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });

    const result = harn(root, ["agents", "heal", "--json"], cursorEnv());

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      rows: [
        {
          instance_id: CURSOR_SESSION,
          outcome: "cache_present",
          after: { instance_id: CURSOR_SESSION, platform: "cursor" },
        },
      ],
      meta: { automatic: true, adapter: "cursor", bootstrap: "created" },
    });
    expect(readHookProducerStateV3(root, "codex", OWNER)).toBeDefined();
    expect(readHeartbeat(root, CURSOR_SESSION)).toMatchObject({
      instance_id: CURSOR_SESSION,
      platform: "cursor",
    });
    expect(readHookProducerStateV3(root, "cursor", CURSOR_SESSION)).toBeDefined();
    expect(
      ledgerEvents(root).filter((event) => event.event_type === "session.started"),
    ).toHaveLength(2);
    expectNoInventedTurn(root);
  });

  test("an exact Cursor session generation outranks an unrelated active peer", () => {
    const root = makeSandbox();
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected active V3 route");
    const recorded = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-start",
      payload: { session_id: CURSOR_SESSION, raw: {}, source: "resume" },
      adapter: "cursor",
      instanceId: CURSOR_OWNER,
    });
    if (recorded.state !== "recorded") throw new Error(`session start was ${recorded.state}`);
    const generation = readHookProducerStateV3(root, "cursor", CURSOR_SESSION)?.generation_id;
    if (!generation) throw new Error("expected Cursor producer generation");

    const result = harn(root, ["agents", "heal", "--json"], cursorEnv());

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      rows: [
        {
          instance_id: CURSOR_OWNER,
          outcome: "cache_present",
          after: {
            instance_id: CURSOR_OWNER,
            platform: "cursor",
            v3_generation_id: generation,
          },
        },
      ],
      meta: { automatic: true, adapter: "cursor" },
    });
    expect(readHookProducerStateV3(root, "cursor", CURSOR_SESSION)?.generation_id).toBe(generation);
    expect(
      ledgerEvents(root).filter((event) => event.event_type === "session.started"),
    ).toHaveLength(2);
    expectNoInventedTurn(root);
  });

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

  test("explicit repair refuses a foreign owner without inventing a turn", () => {
    const foreignRoot = makeSandbox();
    const foreign = harn(foreignRoot, [
      "agents",
      "heal",
      "--kind",
      "cache",
      "--owner",
      FOREIGN_OWNER,
      "--session-id",
      OWNER,
      "--adapter",
      "codex",
      "--json",
    ]);
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toContain("heal_failed");
    expect(foreign.stderr).toContain("reason=owner_mismatch");
    expect(readHeartbeat(foreignRoot, FOREIGN_OWNER)).toBeNull();
    expect(
      ledgerEvents(foreignRoot).filter((event) => event.event_type === "session.started"),
    ).toHaveLength(1);
    expectNoInventedTurn(foreignRoot);
  });

  test("explicit repair refuses an adapter mismatch without inventing a turn", () => {
    const crossAdapterRoot = makeLedgerSandbox();
    const route = resolveLiveEventLedgerRouteV3(crossAdapterRoot);
    if (route.state !== "v3") throw new Error("expected active V3 route");
    const recorded = recordLiveHookSignalV3({
      coordRoot: crossAdapterRoot,
      route,
      eventName: "session-start",
      payload: { session_id: OWNER, raw: {}, source: "resume" },
      adapter: "cursor",
      instanceId: OWNER,
    });
    if (recorded.state !== "recorded") throw new Error(`session start was ${recorded.state}`);
    const crossAdapter = harn(crossAdapterRoot, [
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
    expect(crossAdapter.status).toBe(1);
    expect(crossAdapter.stderr).toContain("heal_failed");
    expect(crossAdapter.stderr).toContain("reason=adapter_mismatch");
    expect(readHeartbeat(crossAdapterRoot, OWNER)).toBeNull();
    expect(
      ledgerEvents(crossAdapterRoot).filter((event) => event.event_type === "session.started"),
    ).toHaveLength(1);
    expectNoInventedTurn(crossAdapterRoot);
  });

  test("explicit repair refuses a terminal generation without inventing a turn", () => {
    const terminalRoot = makeSandbox();
    const terminalGeneration = endSession(terminalRoot, "codex");
    rmSync(path.join(terminalRoot, ".harnery", "active", `${OWNER}.json`), { force: true });
    const terminal = harn(terminalRoot, [
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
    expect(terminal.status).toBe(1);
    expect(terminal.stderr).toContain("heal_failed");
    expect(terminal.stderr).toContain("reason=terminal_generation");
    expect(readHeartbeat(terminalRoot, OWNER)).toBeNull();
    expect(readHookProducerStateV3(terminalRoot, "codex", OWNER)).toMatchObject({
      generation_id: terminalGeneration,
      terminal: true,
    });
    expect(
      ledgerEvents(terminalRoot).filter((event) => event.event_type === "session.started"),
    ).toHaveLength(1);
    expectNoInventedTurn(terminalRoot);
  });

  test.each([
    ["owner", ["--owner", OWNER]],
    ["session", ["--session-id", OWNER]],
    ["adapter", ["--adapter", "codex"]],
    ["empty owner", ["--owner", ""]],
    ["empty session", ["--session-id", ""]],
    ["empty adapter", ["--adapter", ""]],
  ] as const)("does not bootstrap empty authority with an explicit %s flag", (_label, flags) => {
    const root = makeLedgerSandbox();

    const result = harn(root, ["agents", "heal", ...flags, "--json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("heal_failed");
    expect(result.stderr).toContain("reason=authority_missing");
    expect(readHookProducerStateV3(root, "codex", OWNER)).toBeUndefined();
    expect(readHeartbeat(root, OWNER)).toBeNull();
    expect(ledgerEvents(root).filter((event) => event.event_type === "session.started")).toEqual(
      [],
    );
    expectNoInventedTurn(root);
  });
});
