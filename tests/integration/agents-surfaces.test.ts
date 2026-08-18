import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recordLiveLifecycleChangeV2,
  recordLiveTaskChangeV2,
} from "../../src/core/agents/live-authority-v2.ts";
import { ensureLiveCoordinationHeartbeat } from "../../src/core/agents/state/live-coordination-view.ts";
import { initializeEventLedgerV2 } from "../../src/core/events/v2/bootstrap.ts";
import { sha256V2 } from "../../src/core/events/v2/canonical.ts";
import {
  recordLiveHookSignalV2,
  resolveLiveEventLedgerRouteV2,
} from "../../src/core/events/v2/live-routing.ts";

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
  initializeEventLedgerV2({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V2("config"),
    approvalRecordId: "test-agents-surfaces",
  });
  const route = resolveLiveEventLedgerRouteV2(root);
  if (route.state !== "v2") throw new Error("expected active V2 route");
  const record = (eventName: string, payload: Record<string, unknown>) =>
    recordLiveHookSignalV2({
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
  recordLiveTaskChangeV2({
    coordRoot: root,
    owner: OWNER,
    nativeSessionId: OWNER,
    adapter: "codex",
    task: "Review auth",
  });
  recordLiveLifecycleChangeV2({
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
      activity_source: "event-v2-coordination-view",
      task_state: "blocked",
    });

    expect(json(harn(root, ["agents", "whoami", "--json"]))).toMatchObject({
      activity: "needs_input",
      activity_updated_at: expect.any(String),
      task_state: "blocked",
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
      activity_source: "event-v2-coordination-view",
      task_state: "blocked",
    });
    const entries = traced.entries as Array<Record<string, unknown>>;
    expect(entries.some((entry) => entry.event_type === "interaction.wait_started")).toBe(true);
    expect(entries.some((entry) => entry.event_type === "coord.lifecycle_changed")).toBe(true);
    const human = harn(root, ["agents", "trace", "Hollis"]);
    expect(human.stdout).toContain("activity=needs_input · lifecycle=blocked");
  });

  test("incomplete disposable cache rows use evidence-safe reader defaults", () => {
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
      activity: "unknown",
      task_state: "active",
    });
  });
});

describe("codex-wsl bridge ping attribution", () => {
  const TARGET = "surface-target";

  function addTarget(root: string): string {
    const heartbeat = path.join(root, ".harnery", "active", `${TARGET}.json`);
    writeFileSync(
      heartbeat,
      JSON.stringify({
        schema_version: 2,
        instance_id: TARGET,
        session_id: TARGET,
        kind: "session",
        name: "Target",
        platform: "claude-code",
        started_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
        files_touched: [],
      }),
    );
    return heartbeat;
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
    expect(result.status).toBe(0);
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
});
