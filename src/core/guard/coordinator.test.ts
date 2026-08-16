import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateRunQualityIfDue } from "./coordinator.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("file-backed run-quality coordinator", () => {
  test("evaluates all live instances with a dedicated cursor and emits advisory transitions", () => {
    const project = root();
    configure(project, "report");
    heartbeat(project, "instance-a", "session-a");
    ledger(project, [
      event("01", "session.start", {}),
      event("02", "tool.pre_use", { tool_name: "Read", input_hash: "same" }),
      event("03", "tool.pre_use", { tool_name: "Read", input_hash: "same" }),
    ]);

    const result = evaluateRunQualityIfDue(
      project,
      new Date("2026-08-15T00:00:00.000Z"),
      "instance-a",
    );
    expect(result.evaluated).toBe(true);
    expect(result.snapshot?.status).toBe("attention");
    expect(existsSync(join(project, ".harnery", "guard", "cursor.json"))).toBe(true);
    expect(existsSync(join(project, ".harnery", ".events-cursor"))).toBe(false);
    const rows = readFileSync(join(project, ".harnery", "events.ndjson"), "utf8");
    expect(rows).toContain('"event_type":"health.run_quality_changed"');
    expect(rows).not.toContain('"event_type":"decision.warn"');

    const notDue = evaluateRunQualityIfDue(
      project,
      new Date("2026-08-15T00:00:01.000Z"),
      "instance-a",
    );
    expect(notDue.evaluated).toBe(false);
    expect(notDue.snapshot?.status).toBe("attention");
  });

  test("missing retained session history degrades to unknown", () => {
    const project = root();
    configure(project, "shadow");
    heartbeat(project, "instance-a", "session-a");
    ledger(project, [event("02", "tool.pre_use", { tool_name: "Read", input_hash: "one" })]);
    const result = evaluateRunQualityIfDue(
      project,
      new Date("2026-08-15T00:00:00.000Z"),
      "instance-a",
    );
    expect(result.snapshot?.status).toBe("unknown");
    expect(result.snapshot?.reason).toBe("insufficient_evidence");
  });

  test.each([
    "NotebookEdit",
    "StrReplace",
  ])("treats a successful %s outcome as progress", (toolName) => {
    const project = root();
    configure(project, "shadow");
    heartbeat(project, "instance-a", "session-a");
    ledger(project, [
      event("01", "session.start", {}),
      event("02", "tool.pre_use", { tool_name: toolName, input_hash: "write" }),
      event("03", "tool.post_use", { tool_name: toolName, success: true }),
    ]);

    const result = evaluateRunQualityIfDue(
      project,
      new Date("2026-08-15T00:00:00.000Z"),
      "instance-a",
    );

    expect(result.snapshot?.state.work_since_progress).toBe(0);
  });

  test("follows a cursor event when live-ledger rotation moves it into the newest archive", () => {
    const project = root();
    configure(project, "shadow");
    heartbeat(project, "instance-a", "session-a");
    ledger(project, [event("01", "session.start", {}), event("02", "user_prompt.submit", {})]);
    const first = evaluateRunQualityIfDue(project, new Date("2026-08-15T00:00:00Z"), "instance-a");
    expect(first.snapshot?.status).toBe("healthy");
    renameSync(
      join(project, ".harnery", "events.ndjson"),
      join(project, ".harnery", "events-2026-08-15.ndjson"),
    );
    ledger(project, [event("03", "tool.pre_use", { tool_name: "Read", input_hash: "one" })]);
    const second = evaluateRunQualityIfDue(project, new Date("2026-08-15T00:00:11Z"), "instance-a");
    expect(second.snapshot?.evidence).toMatchObject({ last_event_id: "03", truncated: false });
    expect(second.snapshot?.status).not.toBe("unknown");
  });

  test("invalid config emits once per digest and disables evaluation", () => {
    const project = root();
    configure(project, "report", { max_tail_bytes: 1 });
    heartbeat(project, "instance-a", "session-a");
    const first = evaluateRunQualityIfDue(project, new Date("2026-08-15T00:00:00Z"), "instance-a");
    const second = evaluateRunQualityIfDue(project, new Date("2026-08-15T00:01:00Z"), "instance-a");
    expect(first.config.valid).toBe(false);
    expect(second.evaluated).toBe(false);
    const events = readFileSync(join(project, ".harnery", "events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event_type: string });
    expect(
      events.filter((event) => event.event_type === "health.run_quality_config_invalid"),
    ).toHaveLength(1);
  });

  test("removes orphan live-generation snapshots on a later evaluation", () => {
    const project = root();
    configure(project, "shadow");
    heartbeat(project, "instance-a", "session-a");
    ledger(project, [event("01", "session.start", {})]);
    evaluateRunQualityIfDue(project, new Date("2026-08-15T00:00:00Z"), "instance-a");
    const snapshot = join(project, ".harnery", "guard", "instance-a.json");
    expect(existsSync(snapshot)).toBe(true);
    rmSync(join(project, ".harnery", "active", "instance-a.json"));
    evaluateRunQualityIfDue(project, new Date("2026-08-15T00:01:00Z"));
    expect(existsSync(snapshot)).toBe(false);
  });

  test("does not create deadline epochs for stale heartbeats and cleans their snapshots", () => {
    const project = root();
    configure(project, "shadow");
    heartbeat(project, "instance-a", "session-a");
    ledger(project, [event("01", "session.start", {})]);
    evaluateRunQualityIfDue(project, new Date("2026-08-15T00:00:00Z"), "instance-a");
    const snapshot = join(project, ".harnery", "guard", "instance-a.json");
    expect(existsSync(snapshot)).toBe(true);
    evaluateRunQualityIfDue(project, new Date("2026-08-15T00:11:00Z"));
    expect(existsSync(snapshot)).toBe(false);
  });
});

function root(): string {
  const path = join(
    tmpdir(),
    `harnery-run-quality-coordinator-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(join(path, ".harnery", "active"), { recursive: true });
  roots.push(path);
  return path;
}

function configure(
  project: string,
  mode: "shadow" | "report",
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(project, ".harnery", "config.jsonc"),
    `${JSON.stringify({
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
          ...extra,
        },
      },
    })}\n`,
  );
}

function heartbeat(project: string, instanceId: string, sessionId: string): void {
  writeFileSync(
    join(project, ".harnery", "active", `${instanceId}.json`),
    `${JSON.stringify({
      instance_id: instanceId,
      session_id: sessionId,
      agent_id: instanceId,
      name: "Fixture",
      model: "fixture",
      platform: "claude-code",
      started_at: "2026-08-15T00:00:00.000Z",
      last_heartbeat: "2026-08-15T00:00:00.000Z",
      files_touched: [],
    })}\n`,
  );
}

function ledger(project: string, rows: unknown[]): void {
  writeFileSync(
    join(project, ".harnery", "events.ndjson"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
}

function event(eventId: string, eventType: string, data: Record<string, unknown>) {
  return {
    schema_version: 1,
    event_id: eventId,
    event_type: eventType,
    ts: "2026-08-15T00:00:00.000Z",
    instance_id: "instance-a",
    session_id: "session-a",
    adapter: "claude-code",
    source: "agent-hooks",
    data,
  };
}
