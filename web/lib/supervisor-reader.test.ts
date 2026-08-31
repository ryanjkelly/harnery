import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupervisorHookHealth } from "../../src/core/supervisor/hook-health";
import { writeSupervisorHookHealth } from "../../src/core/supervisor/hook-health-storage";
import { readSupervisorDashboard } from "./supervisor-reader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("supervisor dashboard reader", () => {
  test("includes a valid completed hook-health projection", () => {
    const root = mkdtempSync(join(tmpdir(), "harn-supervisor-reader-"));
    roots.push(root);
    const hookHealth: SupervisorHookHealth = {
      schema_version: 1,
      captured_at: "2026-08-31T12:00:00.000Z",
      capability: { source_kind: "hook.terminal-log", state: "supported" },
      source_record_count: 1,
      malformed_record_count: 0,
      truncated: false,
      summary: {
        invocation_count: 1,
        degraded_count: 0,
        faulted_count: 0,
        slow_count: 0,
        high_memory_count: 0,
        retry_count: 0,
      },
      aggregates: [],
      recent: [],
    };
    writeSupervisorHookHealth(root, hookHealth);
    expect(readSupervisorDashboard(root).hookHealth).toEqual(hookHealth);
  });
});
