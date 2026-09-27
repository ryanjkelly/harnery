import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../tests/helpers/event-v3-runtime.ts";
import {
  autoCleanArtifacts,
  cleanArtifacts,
  createArtifact,
  holdArtifact,
  inventoryArtifacts,
  readArtifactDeletions,
} from "./index.ts";

const MiB = 1024 * 1024;
const HOUR_MS = 60 * 60 * 1000;
const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function repo(): string {
  const path = mkdtempSync(join(tmpdir(), "harnery-artifact-size-"));
  roots.push(path);
  Bun.spawnSync(["git", "init", "-q"], { cwd: path });
  return path;
}

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

/** Offsets from the real clock, because idle time derives from real file times. */
function later(hours: number): Date {
  return new Date(Date.now() + hours * HOUR_MS);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of Object.keys(savedEnv)) delete savedEnv[key];
});

describe("artifact size rules", () => {
  test("measure disk use, so a sparse file does not count at full length", () => {
    const root = repo();
    setEnv("HARNERY_ARTIFACT_MAX_UNIT_BYTES", String(16 * MiB));
    const unit = createArtifact(root, { slug: "sparse", purpose: "Disk image", retentionDays: 3 });
    writeFileSync(join(unit.path, "disk.img"), "");
    truncateSync(join(unit.path, "disk.img"), 512 * MiB);

    const [row] = inventoryArtifacts(root, { now: later(48) });
    expect(row?.classification).toBe("managed-current");
    expect(row?.apparent_bytes).toBeGreaterThan(512 * MiB);
    expect(row?.bytes).toBeLessThan(MiB);
    expect(row?.warning).toBeNull();
  });

  test("count a hard-linked file once", () => {
    const root = repo();
    const unit = createArtifact(root, { slug: "links", purpose: "Linked env", retentionDays: 3 });
    writeFileSync(join(unit.path, "a.bin"), randomBytes(2 * MiB));
    linkSync(join(unit.path, "a.bin"), join(unit.path, "b.bin"));

    const [row] = inventoryArtifacts(root);
    expect(row?.apparent_bytes).toBeGreaterThanOrEqual(4 * MiB);
    expect(row?.bytes).toBeLessThan(3 * MiB);
  });

  test("keep held bytes out of the repository budget", () => {
    const root = repo();
    setEnv("HARNERY_ARTIFACT_MAX_BYTES", String(64 * MiB));
    const held = createArtifact(root, {
      slug: "held-images",
      purpose: "Provider images",
      retentionDays: 3,
      big: true,
      actor: { instance_id: "agent_holder01" },
      holds: [{ id: "review", reason: "Pending review" }],
    });
    writeFileSync(join(held.path, "images.bin"), randomBytes(70 * MiB));
    const small = createArtifact(root, { slug: "scan", purpose: "Scan", retentionDays: 3 });
    writeFileSync(join(small.path, "scan.txt"), "findings\n");

    const rows = inventoryArtifacts(root, { now: later(48) });
    expect(rows.find((row) => row.path === held.path)?.classification).toBe("managed-held");
    expect(rows.find((row) => row.path === small.path)).toMatchObject({
      classification: "managed-current",
      action: "keep",
    });
  });

  test("wait out the idle grace before evicting over budget", () => {
    const root = repo();
    setEnv("HARNERY_ARTIFACT_MAX_BYTES", String(64 * MiB));
    const early = createArtifact(root, {
      slug: "early",
      purpose: "First",
      retentionDays: 3,
      big: true,
    });
    const late = createArtifact(root, {
      slug: "late",
      purpose: "Second",
      retentionDays: 5,
      big: true,
    });
    writeFileSync(join(early.path, "a.bin"), randomBytes(40 * MiB));
    writeFileSync(join(late.path, "b.bin"), randomBytes(40 * MiB));

    const within = inventoryArtifacts(root, { now: later(2) });
    expect(within.every((row) => row.action === "keep")).toBe(true);
    const after = inventoryArtifacts(root, { now: later(25) });
    expect(after.find((row) => row.path === early.path)?.classification).toBe(
      "managed-over-budget",
    );
  });

  // Regression for a 17 GB listening-test workspace deleted 13 minutes after
  // its owner went idle while a human was still reviewing it.
  test("never delete a large workspace a human is waiting on at session start", () => {
    const root = repo();
    setEnv("HARNERY_ARTIFACT_MAX_UNIT_BYTES", String(16 * MiB));
    setEnv("HARNERY_ARTIFACT_MAX_BYTES", String(64 * MiB));
    initializeV3Fixture(root);
    seedV3Session(root, "agent_waiting01");
    const waiting = createArtifact(root, {
      slug: "tts-bakeoff",
      purpose: "Listening page",
      retentionDays: 3,
      actor: { instance_id: "agent_waiting01" },
    });
    writeFileSync(join(waiting.path, "envs.bin"), randomBytes(20 * MiB));
    writeFileSync(join(waiting.path, "index.html"), "<h1>Listen</h1>\n");
    const held = createArtifact(root, {
      slug: "provider-images",
      purpose: "Sparse images",
      retentionDays: 3,
      big: true,
      actor: { instance_id: "agent_holder02" },
      holds: [{ id: "images", reason: "Still in use" }],
    });
    writeFileSync(join(held.path, "images.img"), "");
    truncateSync(join(held.path, "images.img"), 40 * 1024 * MiB);

    // Owner live: kept, with a warning that names the ceiling.
    const live = inventoryArtifacts(root).find((row) => row.path === waiting.path);
    expect(live?.classification).toBe("managed-active");
    expect(live?.warning).toContain("per-workspace ceiling");

    // Owner idle 13 minutes, then 2 hours: the heartbeat is stale, but the
    // grace has not run out, so session-start cleanup deletes nothing.
    for (const hours of [13 / 60, 2]) {
      const now = later(hours);
      const row = inventoryArtifacts(root, { now }).find((item) => item.path === waiting.path);
      expect(row).toMatchObject({ classification: "managed-current", action: "keep" });
      expect(row?.warning).toContain("cleanup will delete it after");
      setEnv("HARNERY_ARTIFACT_AUTO_CLEAN_INTERVAL_HOURS", "0.0001");
      expect(autoCleanArtifacts(root, { now }).deleted).toBe(0);
      expect(existsSync(waiting.path)).toBe(true);
    }
    expect(existsSync(held.path)).toBe(true);
  });

  test("record each deletion so its owner can find out what happened", () => {
    const root = repo();
    setEnv("HARNERY_ARTIFACT_MAX_UNIT_BYTES", String(16 * MiB));
    const unit = createArtifact(root, {
      slug: "old-env",
      purpose: "Rebuildable env",
      retentionDays: 5,
      actor: { instance_id: "agent_goneaway1" },
    });
    writeFileSync(join(unit.path, "env.bin"), randomBytes(20 * MiB));

    const rows = cleanArtifacts(root, { yes: true, now: later(25) });
    expect(rows[0]).toMatchObject({ classification: "managed-oversize", action: "deleted" });
    expect(existsSync(unit.path)).toBe(false);
    const [record] = readArtifactDeletions(root);
    expect(record).toMatchObject({
      artifact_id: unit.manifest.artifact_id,
      owner_instance_id: "agent_goneaway1",
      classification: "managed-oversize",
    });
    expect(record?.bytes).toBeGreaterThan(20 * MiB - 1);
  });

  test("a hold placed after creation stops a pending size deletion", () => {
    const root = repo();
    setEnv("HARNERY_ARTIFACT_MAX_UNIT_BYTES", String(16 * MiB));
    const unit = createArtifact(root, { slug: "keep", purpose: "Keep me", retentionDays: 5 });
    writeFileSync(join(unit.path, "big.bin"), randomBytes(20 * MiB));
    holdArtifact(root, unit.manifest.artifact_id, {
      id: "keep",
      reason: "Human review",
      actor: { instance_id: "agent_keeper001" },
    });
    expect(cleanArtifacts(root, { yes: true, now: later(48) })[0]?.action).toBe("keep");
    expect(existsSync(unit.path)).toBe(true);
  });
});
