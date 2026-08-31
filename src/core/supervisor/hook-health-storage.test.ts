import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupervisorHookHealth } from "./hook-health.ts";
import {
  readSupervisorHookHealth,
  supervisorHookHealthPath,
  writeSupervisorHookHealth,
} from "./hook-health-storage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("supervisor hook-health storage", () => {
  test("round trips the disposable schema-1 projection under the supervisor root", () => {
    const root = mkdtempSync(join(tmpdir(), "harn-hook-health-storage-"));
    roots.push(root);
    const value = projection();
    writeSupervisorHookHealth(root, value);
    expect(supervisorHookHealthPath(root)).toBe(
      join(root, ".harnery", "supervisor", "hook-health.json"),
    );
    expect(readSupervisorHookHealth(root)).toEqual(value);
  });
});

function projection(): SupervisorHookHealth {
  return {
    schema_version: 1,
    captured_at: "2026-08-31T12:00:00.000Z",
    capability: { source_kind: "hook.terminal-log", state: "supported" },
    source_record_count: 0,
    malformed_record_count: 0,
    truncated: false,
    summary: {
      invocation_count: 0,
      degraded_count: 0,
      faulted_count: 0,
      slow_count: 0,
      high_memory_count: 0,
      retry_count: 0,
    },
    aggregates: [],
    recent: [],
  };
}
