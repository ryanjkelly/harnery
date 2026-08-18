import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireEvaluationLock,
  evaluationLockOwned,
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
