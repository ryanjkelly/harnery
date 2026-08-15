import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireEvaluationLock,
  evaluationLockOwned,
  readGuardEventWindow,
  releaseEvaluationLock,
  writeAtomicJson,
} from "./storage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run-quality storage", () => {
  test("lock acquisition is non-blocking and nonce-safe", () => {
    const project = root();
    const first = acquireEvaluationLock(project, new Date("2026-08-15T00:00:00Z"), 60)!;
    expect(acquireEvaluationLock(project, new Date("2026-08-15T00:00:01Z"), 60)).toBeNull();
    releaseEvaluationLock(project, "replacement-nonce");
    expect(evaluationLockOwned(project, first.nonce)).toBe(true);
    releaseEvaluationLock(project, first.nonce);
    expect(existsSync(join(project, ".harnery", "guard", "evaluate.lock"))).toBe(false);
  });

  test("steals a crashed or stale holder", () => {
    const project = root();
    const dir = join(project, ".harnery", "guard");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "evaluate.lock"),
      JSON.stringify({ pid: 999_999_999, acquired_at: "2026-08-14T00:00:00Z", nonce: "dead" }),
    );
    const lock = acquireEvaluationLock(project, new Date("2026-08-15T00:00:00Z"), 60);
    expect(lock).not.toBeNull();
    expect(lock?.nonce).not.toBe("dead");
    releaseEvaluationLock(project, lock!.nonce);
  });

  test("a late publisher cannot rename after its nonce is stolen", () => {
    const project = root();
    const path = join(project, ".harnery", "guard", "late.json");
    expect(() => writeAtomicJson(path, { status: "critical" }, "old", () => false)).toThrow(
      "run_quality_lock_stolen",
    );
    expect(existsSync(path)).toBe(false);
  });

  test("rebuild window reads only the newest archive plus the live segment", () => {
    const project = root();
    const dir = join(project, ".harnery");
    writeFileSync(join(dir, "events-2026-08-13.ndjson"), `${line("01", "old")}\n`);
    writeFileSync(join(dir, "events-2026-08-14.ndjson"), `${line("02", "newest")}\n`);
    writeFileSync(join(dir, "events.ndjson"), `${line("03", "live")}\n`);
    const window = readGuardEventWindow(project, 64 * 1024);
    expect(window.events.map((event) => event.event_id)).toEqual(["02", "03"]);
    expect(window.events.map((event) => event.segment)).toEqual([
      ".harnery/events-2026-08-14.ndjson",
      ".harnery/events.ndjson",
    ]);
  });

  test("a maximum-tail scan remains byte-bounded and completes within the lazy-read budget", () => {
    const project = root();
    const row = `${line("01", "fixture")}\n`;
    writeFileSync(
      join(project, ".harnery", "events.ndjson"),
      row.repeat(Math.ceil((4 * 1024 * 1024) / Buffer.byteLength(row))),
    );
    const started = performance.now();
    const window = readGuardEventWindow(project, 2 * 1024 * 1024);
    const durationMs = performance.now() - started;
    expect(window.truncated).toBe(true);
    expect(window.events.length).toBeGreaterThan(0);
    expect(durationMs).toBeLessThan(2_000);
  });
});

function root(): string {
  const path = join(
    tmpdir(),
    `harnery-run-quality-storage-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(join(path, ".harnery"), { recursive: true });
  roots.push(path);
  return path;
}

function line(eventId: string, instanceId: string): string {
  return JSON.stringify({
    schema_version: 1,
    event_id: eventId,
    event_type: "tool.pre_use",
    ts: "2026-08-15T00:00:00.000Z",
    instance_id: instanceId,
    session_id: instanceId,
    adapter: "claude-code",
    source: "agent-hooks",
    data: { tool_name: "Read", input_hash: "a" },
  });
}
