import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCleanArtifacts, createArtifact } from "./index.ts";

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-autoclean-"));
  // Without a repo the tracked-paths guard fails closed (managed-tracked) and
  // nothing ever classifies as expired.
  spawnSync("git", ["init", "-q", root], { stdio: "ignore" });
  roots.push(root);
  return root;
}

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});

/** One artifact created at t0 with a 1-day TTL, plus a payload file. */
function seedExpired(root: string, t0: Date, slug = "sweep-me"): string {
  const created = createArtifact(root, {
    slug,
    purpose: "test payload",
    retentionDays: 1,
    now: t0,
  });
  writeFileSync(join(created.path, "payload.txt"), "expired bytes\n");
  return created.path;
}

// Times run FORWARD from the real clock: expiry derives from real file
// mtimes (retention resets on modification), so a fake past `now` would make
// freshly-written test files look modified-in-the-future and never expired.
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = new Date();
const T0_PLUS_3D = new Date(T0.getTime() + 3 * DAY_MS);
const T0_PLUS_3D_PLUS_12H = new Date(T0.getTime() + 3.5 * DAY_MS);
const T0_PLUS_3D_PLUS_25H = new Date(T0.getTime() + 3 * DAY_MS + 25 * 60 * 60 * 1000);

describe("autoCleanArtifacts", () => {
  test("sweeps expired workspaces and stamps the run", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    const result = autoCleanArtifacts(root, { now: T0_PLUS_3D });
    expect(result).toMatchObject({ ran: true, reason: "swept", deleted: 1 });
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
    const stamp = JSON.parse(
      readFileSync(join(root, ".harnery", "artifacts-auto-clean.json"), "utf8"),
    );
    expect(stamp.last_run_at).toBe(T0_PLUS_3D.toISOString());
    expect(stamp.deleted).toBe(1);
  });

  test("keeps an unexpired workspace", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    const result = autoCleanArtifacts(root, { now: new Date(T0.getTime() + 12 * 60 * 60 * 1000) });
    expect(result.deleted).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test("throttles to once per interval", () => {
    const root = makeRoot();
    seedExpired(root, T0);
    autoCleanArtifacts(root, { now: T0_PLUS_3D });
    const second = seedExpired(root, T0, "sweep-me-too");
    const throttled = autoCleanArtifacts(root, { now: T0_PLUS_3D_PLUS_12H });
    expect(throttled).toMatchObject({ ran: false, reason: "fresh", deleted: 0 });
    expect(existsSync(second)).toBe(true);
    const later = autoCleanArtifacts(root, { now: T0_PLUS_3D_PLUS_25H });
    expect(later).toMatchObject({ ran: true, reason: "swept", deleted: 1 });
    expect(existsSync(second)).toBe(false);
  });

  test("never touches unmanaged directories", () => {
    const root = makeRoot();
    seedExpired(root, T0);
    const legacy = join(root, ".harnery", "artifacts", "legacy-dump");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "keep.txt"), "no manifest\n");
    autoCleanArtifacts(root, { now: T0_PLUS_3D });
    expect(existsSync(join(legacy, "keep.txt"))).toBe(true);
  });

  test("env kill-switch disables the sweep", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    setEnv("HARNERY_ARTIFACT_AUTO_CLEAN", "0");
    const result = autoCleanArtifacts(root, { now: T0_PLUS_3D });
    expect(result).toMatchObject({ ran: false, reason: "disabled" });
    expect(existsSync(path)).toBe(true);
  });

  test("config kill-switch disables the sweep", () => {
    const root = makeRoot();
    const path = seedExpired(root, T0);
    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      '{ "artifacts": { "auto_clean": false } }\n',
    );
    const result = autoCleanArtifacts(root, { now: T0_PLUS_3D });
    expect(result).toMatchObject({ ran: false, reason: "disabled" });
    expect(existsSync(path)).toBe(true);
  });

  test("reports no-root when the store does not exist", () => {
    const root = makeRoot();
    expect(autoCleanArtifacts(root, { now: T0 })).toMatchObject({ ran: false, reason: "no-root" });
  });
});
