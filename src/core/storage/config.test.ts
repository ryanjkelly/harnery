import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harneryStorageFamilies } from "./builtins.ts";
import {
  MAX_LOG_STORAGE_AGE_DAYS,
  MAX_LOG_STORAGE_BYTES,
  MIN_LOG_STORAGE_AGE_DAYS,
  MIN_LOG_STORAGE_BYTES,
  resolveLogStorageConfiguration,
  withEffectiveLogRetention,
} from "./config.ts";

const roots: string[] = [];
const savedXdg = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
});

describe("log storage configuration", () => {
  test("keeps exact-family specificity above a project class while preserving provenance", () => {
    const root = fixture(
      {
        classes: {
          "operational-log": { max_bytes: 32 * 1024 * 1024, max_age_days: 20 },
        },
        families: { "web-performance-log": { max_age_days: 9 } },
      },
      {
        classes: {
          "operational-log": { max_bytes: 48 * 1024 * 1024, max_age_days: 12 },
        },
        families: { "web-performance-log": { max_bytes: 96 * 1024 * 1024 } },
      },
    );

    const resolution = resolve(root);
    const effective = resolution.families.get("web-performance-log")!;
    expect(effective).toMatchObject({
      state: "valid",
      max_bytes: 96 * 1024 * 1024,
      max_age_days: 9,
      provenance: {
        max_bytes: { source: "project-family", selector: "web-performance-log" },
        max_age_days: { source: "user-family", selector: "web-performance-log" },
      },
    });
  });

  test("project values override user values at the same JSON path", () => {
    const root = fixture(
      { families: { "agent-hook-debug-log": { max_bytes: 20 * 1024 * 1024 } } },
      { families: { "agent-hook-debug-log": { max_bytes: 30 * 1024 * 1024 } } },
    );
    expect(resolve(root).families.get("agent-hook-debug-log")).toMatchObject({
      max_bytes: 30 * 1024 * 1024,
      provenance: { max_bytes: { source: "project-family" } },
    });
  });

  test("uses exact source-owned defaults and stable separate fingerprints", () => {
    const root = fixture({}, {});
    const first = resolve(root).families.get("agent-operational-log")!;
    const second = resolve(root).families.get("agent-operational-log")!;
    expect(first).toMatchObject({
      max_bytes: 128 * 1024 * 1024,
      max_age_days: 30,
      provenance: {
        max_bytes: { source: "built-in", selector: "agent-operational-log" },
        max_age_days: { source: "built-in", selector: "agent-operational-log" },
      },
    });
    expect(first.effective_policy_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.effective_policy_fingerprint).toBe(second.effective_policy_fingerprint);
    expect(first.effective_policy_fingerprint).not.toBe(
      harneryStorageFamilies().find(({ id }) => id === "agent-operational-log")!.policy
        .policy_version,
    );
    const changed = resolve(
      fixture({}, { families: { "agent-operational-log": { max_bytes: 129 * 1024 * 1024 } } }),
    ).families.get("agent-operational-log")!;
    expect(changed.effective_policy_fingerprint).not.toBe(first.effective_policy_fingerprint);
  });

  test("accepts every inclusive schema boundary", () => {
    const root = fixture(
      {
        families: {
          "agent-operational-log": {
            max_bytes: MIN_LOG_STORAGE_BYTES,
            max_age_days: MIN_LOG_STORAGE_AGE_DAYS,
          },
          "agent-hook-debug-log": {
            max_bytes: MAX_LOG_STORAGE_BYTES,
            max_age_days: MAX_LOG_STORAGE_AGE_DAYS,
          },
        },
      },
      {},
    );
    const resolution = resolve(root);
    expect(resolution.state).toBe("valid");
    expect(resolution.families.get("agent-operational-log")).toMatchObject({
      max_bytes: MIN_LOG_STORAGE_BYTES,
      max_age_days: MIN_LOG_STORAGE_AGE_DAYS,
    });
    expect(resolution.families.get("agent-hook-debug-log")).toMatchObject({
      max_bytes: MAX_LOG_STORAGE_BYTES,
      max_age_days: MAX_LOG_STORAGE_AGE_DAYS,
    });
  });

  test("rejects null, fractional, and out-of-range values as one fail-closed unit", () => {
    for (const override of [
      { max_bytes: null },
      { max_bytes: MIN_LOG_STORAGE_BYTES - 1 },
      { max_bytes: MAX_LOG_STORAGE_BYTES + 1 },
      { max_age_days: 1.5 },
      { max_age_days: 0 },
      { max_age_days: MAX_LOG_STORAGE_AGE_DAYS + 1 },
    ]) {
      const root = fixture({}, { families: { "agent-operational-log": override } });
      const resolution = resolve(root);
      expect(resolution.state, JSON.stringify(override)).toBe("invalid");
      expect(resolution.families.get("agent-operational-log")?.state).toBe("invalid");
      expect(resolution.diagnostics.some(({ code }) => code === "value_out_of_range")).toBeTrue();
    }
  });

  test("keeps an absent user-global host family dormant without disabling known families", () => {
    const root = fixture(
      { families: { "host-analytics-log": { max_bytes: 20 * 1024 * 1024 } } },
      {},
    );
    const resolution = resolve(root);
    expect(resolution.state).toBe("valid");
    expect(resolution.dormant_user_families).toEqual(["host-analytics-log"]);
    expect(resolution.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "dormant_user_family",
        layer: "user",
        family_id: "host-analytics-log",
      }),
    );
    expect(resolution.families.get("agent-operational-log")?.state).toBe("valid");
  });

  test("still validates the override body of a dormant user-global family", () => {
    const resolution = resolve(
      fixture({ families: { "host-analytics-log": { max_bytes: MIN_LOG_STORAGE_BYTES - 1 } } }, {}),
    );
    expect(resolution.state).toBe("invalid");
    expect(resolution.dormant_user_families).toEqual(["host-analytics-log"]);
    expect(resolution.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "value_out_of_range",
        layer: "user",
        family_id: "host-analytics-log",
      }),
    );
  });

  test("fails closed for unknown project families, non-log families, and unknown fields", () => {
    for (const storage of [
      { families: { "missing-log": { max_age_days: 3 } } },
      { families: { "work-item-history": { max_age_days: 3 } } },
      { classes: { "operational-log": { max_files: 3 } } },
      { defaults: { max_bytes: 20 * 1024 * 1024 } },
    ]) {
      const resolution = resolve(fixture({}, storage));
      expect(resolution.state, JSON.stringify(storage)).toBe("invalid");
      expect(resolution.families.get("agent-operational-log")?.state, JSON.stringify(storage)).toBe(
        "invalid",
      );
    }
  });

  test("invalid JSONC disables retention instead of silently applying defaults", () => {
    const root = fixture({}, {});
    writeFileSync(join(root, ".harnery", "config.jsonc"), `{ "logs": {`);
    const resolution = resolve(root);
    expect(resolution.state).toBe("invalid");
    expect(resolution.diagnostics).toContainEqual(
      expect.objectContaining({ code: "config_file_invalid", layer: "project" }),
    );
  });

  test("overlays only retention scalars and keeps source policy identity unchanged", () => {
    const root = fixture(
      {},
      {
        families: {
          "agent-operational-log": { max_bytes: 24 * 1024 * 1024, max_age_days: 2 },
        },
      },
    );
    const family = harneryStorageFamilies().find(({ id }) => id === "agent-operational-log")!;
    const effective = resolve(root).families.get(family.id)!;
    const configured = withEffectiveLogRetention(family, effective);
    expect(configured.policy.policy_version).toBe(family.policy.policy_version);
    expect(configured.policy.retention).toMatchObject({
      status: "active",
      max_bytes: { limit: 24 * 1024 * 1024, unit: "bytes" },
      max_age: { limit: 2 * 24 * 60 * 60 * 1_000, unit: "milliseconds" },
    });
    expect(configured.policy.privacy).toEqual(family.policy.privacy);
    expect(configured.policy.rotation).toEqual(family.policy.rotation);
    expect(configured.provider).toEqual(family.provider);
  });
});

function resolve(root: string) {
  return resolveLogStorageConfiguration(root, harneryStorageFamilies());
}

function fixture(userStorage: unknown, projectStorage: unknown): string {
  const xdg = mkdtempSync(join(tmpdir(), "harnery-log-storage-xdg-"));
  const root = mkdtempSync(join(tmpdir(), "harnery-log-storage-project-"));
  roots.push(xdg, root);
  mkdirSync(join(xdg, "harnery"), { recursive: true });
  mkdirSync(join(root, ".harnery"), { recursive: true });
  writeFileSync(join(xdg, "harnery", "config.jsonc"), config(userStorage));
  writeFileSync(join(root, ".harnery", "config.jsonc"), config(projectStorage));
  process.env.XDG_CONFIG_HOME = xdg;
  return root;
}

function config(storage: unknown): string {
  return `${JSON.stringify({ logs: { storage } }, null, 2)}\n`;
}
