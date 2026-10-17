import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { processStartToken } from "../agents/state/proc-start.ts";
import type { SupervisorServiceStatusRecord } from "./contract.ts";
import { collectServiceHealth } from "./services.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harn-service-health-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

function governor(overrides: Record<string, unknown> = {}): string {
  const dir = join(root, ".harnery", "governor-service");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const path = join(dir, "status.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      host: hostname(),
      nonce: "governor",
      state: "running",
      start_token: processStartToken(process.pid),
      started_at: now,
      heartbeat_at: now,
      ...overrides,
    }),
  );
  return path;
}

function health() {
  return collectServiceHealth(root, supervisor()).services.find(
    (service) => service.id === "governor",
  )!;
}

describe("governor health projection", () => {
  test("uses the canonical generation-verified status record", () => {
    governor();
    expect(health()).toMatchObject({ id: "governor", state: "running", pid: process.pid });
  });

  test("a missing recorded token is unknown and leaves its source untouched", () => {
    const path = governor({ start_token: undefined });
    const before = readFileSync(path, "utf8");
    expect(health()).toMatchObject({
      state: "unknown",
      reason: "governor-process-generation-unknown",
    });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a different process generation is stale rather than running", () => {
    governor({ start_token: "different-generation" });
    expect(health()).toMatchObject({
      state: "stale",
      reason: "recorded-process-generation-different",
    });
  });

  test("remote records cannot establish local process identity", () => {
    governor({ host: `${hostname()}-remote` });
    expect(health().state).toBe("unknown");
  });

  test("a corrupt status is unknown rather than stopped", () => {
    const path = governor();
    writeFileSync(path, "{invalid");
    expect(health().state).toBe("unknown");
    expect(readFileSync(path, "utf8")).toBe("{invalid");
  });

  test("an absent status is stopped and a verified stopped status stays stopped", () => {
    expect(health().state).toBe("stopped");
    governor({ state: "stopped" });
    expect(health().state).toBe("stopped");
  });

  test("a stopped flag cannot hide an unknown process generation", () => {
    governor({ state: "stopped", start_token: undefined });
    expect(health().state).toBe("unknown");
  });

  test("does not fall back to the old detached-service path", () => {
    const path = governor({ start_token: undefined });
    writeFileSync(
      join(root, ".harnery", "governor-service", "service.json"),
      readFileSync(path, "utf8"),
    );
    rmSync(path);
    expect(health().state).toBe("stopped");
  });
});
