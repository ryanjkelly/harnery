import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
    path.join(root, ".harnery", "active", `${OWNER}.json`),
    JSON.stringify({
      schema_version: 2,
      instance_id: OWNER,
      session_id: OWNER,
      kind: "session",
      name: "Hollis",
      platform: "codex",
      started_at: now,
      last_heartbeat: new Date().toISOString(),
      files_touched: [],
      task: "Review auth",
      activity: "needs_input",
      activity_updated_at: "2026-08-13T15:02:00Z",
      activity_source: "interaction.input_requested",
      task_state: "blocked",
      task_state_updated_at: "2026-08-13T15:03:00Z",
      task_state_reason: "waiting for approval",
    }),
  );
  writeFileSync(
    path.join(root, ".harnery", ".name-history"),
    `${JSON.stringify({ instance_id: OWNER, name: "Hollis", kind: "session", ts: now })}\n`,
  );
  const events = [
    {
      schema_version: 2,
      event_id: "01start",
      event_type: "session.start",
      ts: now,
      instance_id: OWNER,
      session_id: OWNER,
      adapter: "codex",
      source: "agent-hook",
      data: { name: "Hollis" },
    },
    {
      schema_version: 2,
      event_id: "01prompt",
      event_type: "user_prompt.submit",
      ts: "2026-08-13T15:01:00Z",
      instance_id: OWNER,
      session_id: OWNER,
      adapter: "codex",
      source: "agent-hook",
      data: {},
    },
    {
      schema_version: 2,
      event_id: "01input",
      event_type: "interaction.input_requested",
      ts: "2026-08-13T15:02:00Z",
      instance_id: OWNER,
      session_id: OWNER,
      adapter: "codex",
      source: "agent-hook",
      data: { request_kind: "permission" },
    },
    {
      schema_version: 2,
      event_id: "01state",
      event_type: "state.task_state",
      ts: "2026-08-13T15:03:00Z",
      instance_id: OWNER,
      session_id: OWNER,
      adapter: "codex",
      source: "agent-coord",
      data: {
        prior_state: "active",
        state: "blocked",
        reason: "waiting for approval",
      },
    },
  ];
  writeFileSync(
    path.join(root, ".harnery", "events.ndjson"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
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
      activity_source: "interaction.input_requested",
      task_state: "blocked",
      task_state_reason: "waiting for approval",
    });

    expect(json(harn(root, ["agents", "whoami", "--json"]))).toMatchObject({
      activity: "needs_input",
      activity_updated_at: "2026-08-13T15:02:00Z",
      task_state: "blocked",
      task_state_updated_at: "2026-08-13T15:03:00Z",
      task_state_reason: "waiting for approval",
    });
  });

  test(
    "status and show render explicit activity and lifecycle labels",
    () => {
      const root = makeSandbox();
      expect(
        json(harn(root, ["agents", "status", "--json", "--session-id", OWNER])),
      ).toMatchObject({
        activity: "needs_input",
        task_state: "blocked",
        task_state_reason: "waiting for approval",
      });
      expect(harn(root, ["agents", "status", "--session-id", OWNER]).stdout).toContain(
        "lifecycle",
      );

      expect(json(harn(root, ["agents", "show", "Hollis", "--json"]))).toMatchObject({
        activity: "needs_input",
        task_state: "blocked",
      });
      const shown = harn(root, ["agents", "show", "Hollis"]);
      expect(shown.stdout).toContain("activity:       needs_input");
      expect(shown.stdout).toContain("lifecycle:      blocked: waiting for approval");
    },
    { timeout: 15_000 },
  );

  test("trace folds durable activity and lifecycle and renders their events", () => {
    const root = makeSandbox();
    const traced = json(harn(root, ["agents", "trace", "Hollis", "--json"]));
    expect(traced).toMatchObject({
      activity: "needs_input",
      activity_source: "interaction.input_requested",
      task_state: "blocked",
      task_state_reason: "waiting for approval",
    });
    const entries = traced.entries as Array<Record<string, unknown>>;
    expect(entries.some((entry) => entry.event_type === "interaction.input_requested")).toBe(true);
    expect(entries.some((entry) => entry.event_type === "state.task_state")).toBe(true);
    const human = harn(root, ["agents", "trace", "Hollis"]);
    expect(human.stdout).toContain("activity=needs_input · lifecycle=blocked");
  });

  test("legacy heartbeats use evidence-safe reader defaults", () => {
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
