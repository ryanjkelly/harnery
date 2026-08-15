import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HARN = join(resolve(import.meta.dir, "../.."), "bin", "harn");
const OWNER = "quality-fixture";
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("harn agents status run quality", () => {
  test("report mode shows a fresh advisory quality line and JSON field", () => {
    const root = sandbox("report");
    const human = harn(root, ["agents", "status", "--session-id", OWNER]);
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("quality");
    expect(human.stdout).toContain("attention (repeated_tool_calls");

    const json = harn(root, ["agents", "status", "--json", "--session-id", OWNER]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      quality: { status: "attention", fresh: true },
    });
  }, 15_000);

  test("shadow mode records a snapshot without exposing severity", () => {
    const root = sandbox("shadow");
    const json = harn(root, ["agents", "status", "--json", "--session-id", OWNER]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout).quality).toBeUndefined();
  }, 15_000);
});

function sandbox(mode: "shadow" | "report"): string {
  const root = mkdtempSync(join(tmpdir(), "harn-run-quality-status-"));
  sandboxes.push(root);
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(root, ".harnery", "config.jsonc"),
    JSON.stringify({
      coord: {
        run_quality: {
          mode,
          evaluation_interval_seconds: 10,
          thresholds: {
            repeated_tool_calls: 2,
            consecutive_failures: 2,
            context_growth_per_minute: 100,
            compaction_grace_seconds: 30,
            no_progress_evaluations: 2,
          },
        },
      },
    }),
  );
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
  const events = [
    event("01", "session.start", now, {}),
    event("02", "tool.pre_use", now, { tool_name: "Read", input_hash: "same" }),
    event("03", "tool.pre_use", now, { tool_name: "Read", input_hash: "same" }),
  ];
  writeFileSync(
    join(root, ".harnery", "events.ndjson"),
    `${events.map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  return root;
}

function event(eventId: string, eventType: string, ts: string, data: Record<string, unknown>) {
  return {
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    ts,
    instance_id: OWNER,
    session_id: OWNER,
    adapter: "claude-code",
    source: "agent-hooks",
    data,
  };
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
