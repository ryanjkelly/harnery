import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordLiveLifecycleChangeV3,
  recordLiveTaskChangeV3,
} from "../../src/core/agents/live-authority-v3.ts";
import { ensureLiveCoordinationHeartbeat } from "../../src/core/agents/state/live-coordination-view.ts";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-routing.ts";
import {
  readHookProducerStateV3,
  recordApprovedSessionEndV3,
} from "../../src/core/events/v3/producers/recorder.ts";

const HARNERY_DIR = path.resolve(import.meta.dir, "../..");
const HARN = path.join(HARNERY_DIR, "bin", "harn");
const OWNER = "surface-owner";
const sandboxes: string[] = [];

function makeSandbox(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-surfaces-"));
  sandboxes.push(root);
  mkdirSync(path.join(root, ".harnery", "active"), { recursive: true });
  const now = "2026-08-13T15:00:00Z";
  writeFileSync(
    path.join(root, ".harnery", ".name-history"),
    `${JSON.stringify({ instance_id: OWNER, name: "Hollis", kind: "session", ts: now })}\n`,
  );
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-agents-surfaces",
  });
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected active V3 route");
  const record = (eventName: string, payload: Record<string, unknown>) =>
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName,
      payload: { session_id: OWNER, raw: {}, ...payload },
      adapter: "codex",
      instanceId: OWNER,
    });
  record("session-start", { model: "gpt-5.6" });
  record("user-prompt-submit", { turn_id: "turn-surface", prompt: "review auth" });
  record("permission-request", { turn_id: "turn-surface", permission_type: "command" });
  ensureLiveCoordinationHeartbeat(root, OWNER, OWNER, "codex", "gpt-5.6");
  recordLiveTaskChangeV3({
    coordRoot: root,
    owner: OWNER,
    nativeSessionId: OWNER,
    adapter: "codex",
    task: "Review auth",
  });
  recordLiveLifecycleChangeV3({
    coordRoot: root,
    owner: OWNER,
    nativeSessionId: OWNER,
    adapter: "codex",
    state: "blocked",
    reason: "waiting for approval",
  });
  return root;
}

function harn(root: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [HARN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HARNERY_COORD_ROOT_OVERRIDE: root,
      HARNERY_AGENT_COORD_OWNER: OWNER,
      HARNERY_AGENT_COORD_BRIDGE: "",
      HARNERY_AGENT_COORD_SESSION_ID: "",
      CODEX_THREAD_ID: "",
      ...extraEnv,
    },
  });
}

function json(result: ReturnType<typeof harn>): Record<string, unknown> {
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

afterEach(() => {
  while (sandboxes.length > 0) {
    const root = sandboxes.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("harn agents state surfaces", () => {
  test("list and whoami JSON expose both axes with compatibility timestamps", () => {
    const root = makeSandbox();
    const listed = json(harn(root, ["agents", "list", "--json"]));
    expect((listed.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      activity: "needs_input",
      activity_source: "event-v3-coordination-view",
      task_state: "blocked",
      task_state_scope: "current",
    });

    expect(json(harn(root, ["agents", "whoami", "--json"]))).toMatchObject({
      activity: "needs_input",
      activity_updated_at: expect.any(String),
      task_state: "blocked",
      task_state_scope: "current",
      task_state_updated_at: expect.any(String),
    });
  });

  test(
    "status and show render explicit activity and lifecycle labels",
    () => {
      const root = makeSandbox();
      expect(json(harn(root, ["agents", "status", "--json", "--session-id", OWNER]))).toMatchObject(
        {
          activity: "needs_input",
          task_state: "blocked",
        },
      );
      expect(harn(root, ["agents", "status", "--session-id", OWNER]).stdout).toContain("lifecycle");

      expect(json(harn(root, ["agents", "show", "Hollis", "--json"]))).toMatchObject({
        activity: "needs_input",
        task_state: "blocked",
        task_state_scope: "current",
      });
      const shown = harn(root, ["agents", "show", "Hollis"]);
      expect(shown.stdout).toContain("activity:       needs_input");
      expect(shown.stdout).toContain("lifecycle:      blocked");
    },
    { timeout: 15_000 },
  );

  test("trace folds durable activity and lifecycle and renders their events", () => {
    const root = makeSandbox();
    const traced = json(harn(root, ["agents", "trace", "Hollis", "--json"]));
    expect(traced).toMatchObject({
      activity: "needs_input",
      activity_source: "event-v3-coordination-view",
      task_state: "blocked",
      task_state_scope: "current",
    });
    const entries = traced.entries as Array<Record<string, unknown>>;
    expect(entries.some((entry) => entry.event_type === "wait.started")).toBe(true);
    expect(entries.some((entry) => entry.event_type === "coord.lifecycle_changed")).toBe(true);
    const human = harn(root, ["agents", "trace", "Hollis"]);
    expect(human.stdout).toContain("activity=needs_input · session=live · lifecycle=blocked");
  });

  test("trace labels an ended session separately from its durable work lifecycle", () => {
    const root = makeSandbox();
    recordLiveLifecycleChangeV3({
      coordRoot: root,
      owner: OWNER,
      nativeSessionId: OWNER,
      adapter: "codex",
      state: "active",
    });
    const liveTrace = json(harn(root, ["agents", "trace", "Hollis", "--json"]));
    expect(liveTrace).toMatchObject({
      session_state: "live",
      task_state: "active",
      task_state_scope: "current",
      task_state_updated_at: expect.any(String),
    });
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected active V3 route");
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "stop",
      payload: { session_id: OWNER, turn_id: "turn-surface", raw: {} },
      adapter: "codex",
      instanceId: OWNER,
    });
    const state = readHookProducerStateV3(root, "codex", OWNER);
    if (!state) throw new Error("expected producer state");
    expect(
      recordApprovedSessionEndV3({
        coordRoot: root,
        mode: "active",
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        build_id: route.build_id,
        platform: "linux",
        reason: "approved_explicit_end",
        outcome: "succeeded",
        coordination_finalized: true,
      }).state,
    ).toBe("recorded");

    expect((json(harn(root, ["agents", "list", "--json"])).rows as unknown[]).length).toBe(0);
    expect(harn(root, ["agents", "show", "Hollis", "--json"]).status).toBe(1);
    expect(json(harn(root, ["agents", "trace", "Hollis", "--json"]))).toMatchObject({
      session_state: "ended",
      activity: "idle",
      task_state: "active",
      task_state_scope: "historical",
      task_state_updated_at: liveTrace.task_state_updated_at,
    });
    expect(harn(root, ["agents", "trace", "Hollis"]).stdout).toContain(
      "activity=idle · session=ended · lifecycle=historical(active)",
    );
  });

  test("an incomplete disposable cache cannot override V3 evidence", () => {
    const root = makeSandbox();
    writeFileSync(
      path.join(root, ".harnery", "active", `${OWNER}.json`),
      JSON.stringify({
        instance_id: OWNER,
        session_id: OWNER,
        name: "Hollis",
        started_at: "2026-08-13T15:00:00Z",
        last_heartbeat: new Date().toISOString(),
        files_touched: [],
      }),
    );
    const listed = json(harn(root, ["agents", "list", "--json"]));
    expect((listed.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      activity: "needs_input",
      task_state: "blocked",
    });
  });
});

describe("codex-wsl bridge ping attribution", () => {
  const TARGET = "surface-target";

  function addTarget(root: string): string {
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected active V3 route");
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-start",
      payload: { session_id: TARGET, raw: {} },
      adapter: "claude-code",
      instanceId: TARGET,
    });
    writeFileSync(
      path.join(root, ".harnery", ".name-history"),
      `${JSON.stringify({ instance_id: TARGET, name: "Target", kind: "session", ts: new Date().toISOString() })}\n`,
      { flag: "a" },
    );
    ensureLiveCoordinationHeartbeat(root, TARGET, TARGET, "claude-code");
    return path.join(root, ".harnery", "active", `${TARGET}.json`);
  }

  test("validated bridge session delivers ping as the Codex owner", () => {
    const root = makeSandbox();
    addTarget(root);
    const result = harn(root, ["agents", "ping", "Target", "bridge verdict", "--json"], {
      HARNERY_AGENT_COORD_BRIDGE: "codex-wsl",
      HARNERY_AGENT_COORD_PLATFORM: "codex",
      HARNERY_AGENT_COORD_SESSION_ID: OWNER,
      CODEX_THREAD_ID: OWNER,
      HARNERY_AGENT_COORD_OWNER: "foreign-owner",
    });
    expect(result).toMatchObject({ status: 0 });
    const delivered = JSON.parse(result.stdout) as {
      from: string;
      journal_path: string;
    };
    expect(delivered.from).toBe("Hollis");
    expect(readFileSync(delivered.journal_path, "utf8")).toContain("from agent-Hollis");
  });

  test("invalid bridge session delivers no ping", () => {
    const root = makeSandbox();
    addTarget(root);
    const result = harn(root, ["agents", "ping", "Target", "must not deliver", "--json"], {
      HARNERY_AGENT_COORD_BRIDGE: "codex-wsl",
      HARNERY_AGENT_COORD_PLATFORM: "codex",
      HARNERY_AGENT_COORD_SESSION_ID: "missing-thread",
      CODEX_THREAD_ID: "missing-thread",
      HARNERY_AGENT_COORD_OWNER: OWNER,
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("no_pidmap_entry");
    expect(existsSync(path.join(root, ".harnery", "journal", `${TARGET}.md`))).toBe(false);
  });

  test(
    "refreshed bridge commands keep one identity through lifecycle and Harn End",
    () => {
      const root = makeSandbox();
      addTarget(root);
      const bridgeEnv = {
        HARNERY_AGENT_COORD_BRIDGE: "codex-wsl",
        HARNERY_AGENT_COORD_PLATFORM: "codex",
        HARNERY_AGENT_COORD_SESSION_ID: OWNER,
        CODEX_THREAD_ID: OWNER,
        HARNERY_AGENT_COORD_OWNER: TARGET,
      };

      const whoami = json(harn(root, ["agents", "whoami", "--json"], bridgeEnv));
      expect(whoami).toMatchObject({
        instance_id: OWNER,
        resolution_source: "session_env",
      });
      expect(whoami.session_id).toMatch(/^sid_/);
      const status = json(harn(root, ["agents", "status", "--json"], bridgeEnv));
      expect(status).toMatchObject({
        instance_id: OWNER,
      });
      expect(harn(root, ["agents", "lifecycle", "done"], bridgeEnv).status).toBe(0);
      const shown = json(harn(root, ["agents", "show", "Hollis", "--json"], bridgeEnv));
      expect(shown).toMatchObject({
        instance_id: OWNER,
        session_id: whoami.session_id,
        task_state: "done",
      });

      const ended = harn(
        root,
        ["agents", "status", "--end-turn", "--end-session", "--json"],
        bridgeEnv,
      );
      expect(ended.status).toBe(0);
      expect(json(ended)).toMatchObject({
        instance_id: OWNER,
        session_end: { state: "queued", request_id: expect.any(String) },
      });
      expect(readHookProducerStateV3(root, "codex", OWNER)?.terminal).toBe(false);
      expect(readHookProducerStateV3(root, "claude-code", TARGET)?.terminal).toBe(false);
    },
    { timeout: 30_000 },
  );
});
