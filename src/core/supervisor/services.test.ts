import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import type { SupervisorServiceStatusRecord } from "./contract.ts";
import { collectServiceHealth } from "./services.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harn-service-health-"));
});

afterEach(() => {
  removeDir(root);
});

function supervisor(): SupervisorServiceStatusRecord {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    pid: process.pid,
    host: hostname(),
    nonce: "supervisor",
    state: "running",
    started_at: now,
    heartbeat_at: now,
    interval_ms: 1_000,
    keep_alive: true,
    idle_exit_ms: 1_000,
    cycle_count: 1,
  };
}

describe("service health", () => {
  test("reports the supervisor, semantic reader, presence relay and dashboard", () => {
    const ids = collectServiceHealth(root, supervisor()).services.map((service) => service.id);
    expect(ids).toEqual(["supervisor", "semantic-reader", "presence-relay", "dashboard"]);
  });
});
