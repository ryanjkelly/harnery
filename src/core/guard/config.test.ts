import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunQualityConfig } from "./config.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("run-quality config", () => {
  test("defaults to off when the project has no object", () => {
    const result = readRunQualityConfig(root());
    expect(result.valid).toBe(true);
    expect(result.config?.mode).toBe("off");
  });

  test("validates the complete object and preserves defaults for omitted fields", () => {
    const project = root();
    config(project, { mode: "shadow", thresholds: { repeated_tool_calls: 12 } });
    const result = readRunQualityConfig(project);
    expect(result.valid).toBe(true);
    expect(result.config?.thresholds.repeated_tool_calls).toBe(12);
    expect(result.config?.thresholds.consecutive_failures).toBe(5);
  });

  test("fails the object open instead of partially applying malformed bounds", () => {
    const project = root();
    config(project, { mode: "report", max_tail_bytes: 3, thresholds: { consecutive_failures: 0 } });
    const result = readRunQualityConfig(project);
    expect(result.valid).toBe(false);
    expect(result.config).toBeNull();
    expect(result.requested_mode).toBe("report");
    expect(result.reason_codes).toContain("max_tail_bytes_out_of_range");
    expect(result.reason_codes).toContain("consecutive_failures_out_of_range");
  });

  test("rejects misspelled fields instead of silently defaulting them", () => {
    const project = root();
    config(project, { mode: "shadow", evaluation_interval_second: 30 });
    expect(readRunQualityConfig(project).reason_codes).toContain("unknown_field");
  });

  test("rejects freshness and lock relationships that can create stale gaps or late writers", () => {
    const project = root();
    config(project, {
      mode: "shadow",
      evaluation_interval_seconds: 60,
      snapshot_ttl_seconds: 30,
      evaluation_timeout_seconds: 20,
      lock_stale_seconds: 20,
    });
    const result = readRunQualityConfig(project);
    expect(result.reason_codes).toContain("snapshot_ttl_below_interval");
    expect(result.reason_codes).toContain("lock_stale_not_above_timeout");
  });

  test("detects malformed JSONC", () => {
    const project = root();
    writeFileSync(join(project, ".harnery", "config.jsonc"), '{ "coord": {', "utf8");
    expect(readRunQualityConfig(project)).toMatchObject({
      valid: false,
      requested_mode: "off",
      reason_codes: ["config_json_invalid"],
    });
  });
});

function root(): string {
  const path = join(
    tmpdir(),
    `harnery-run-quality-config-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(join(path, ".harnery"), { recursive: true });
  roots.push(path);
  return path;
}

function config(project: string, value: unknown): void {
  writeFileSync(
    join(project, ".harnery", "config.jsonc"),
    `${JSON.stringify({ coord: { run_quality: value } }, null, 2)}\n`,
    "utf8",
  );
}
