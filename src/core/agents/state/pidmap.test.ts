import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceHasLivePid, prunePidmapDeadRows, writePidmapRow } from "./pidmap.ts";

let root: string;
let pidmapDir: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `pidmap-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  pidmapDir = join(root, ".harnery", "pid-map");
  mkdirSync(pidmapDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

/** A pid nothing is using, so a row for it is unambiguously stale. */
function deadPid(): number {
  for (let candidate = 30000; candidate < 40000; candidate++) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("no unused pid found");
}

function seedRow(pid: number, instanceId: string): void {
  writeFileSync(join(pidmapDir, String(pid)), `${instanceId}\tclaude_code`, "utf8");
}

describe("prunePidmapDeadRows", () => {
  test("drops rows for dead pids and keeps live ones", () => {
    const dead = deadPid();
    seedRow(dead, "ghost-instance");
    seedRow(process.pid, "live-instance");

    const removed = prunePidmapDeadRows(root);

    expect(removed).toBe(1);
    expect(existsSync(join(pidmapDir, String(dead)))).toBe(false);
    expect(existsSync(join(pidmapDir, String(process.pid)))).toBe(true);
  });

  test("leaves a non-numeric filename alone", () => {
    writeFileSync(join(pidmapDir, "README"), "not a row", "utf8");
    expect(prunePidmapDeadRows(root)).toBe(0);
    expect(existsSync(join(pidmapDir, "README"))).toBe(true);
  });

  test("is a no-op when the directory is absent", () => {
    rmSync(pidmapDir, { recursive: true, force: true });
    expect(prunePidmapDeadRows(root)).toBe(0);
  });
});

describe("writePidmapRow", () => {
  test("prunes accumulated dead rows once the directory grows past the threshold", () => {
    // One row per hook shell, and those shells exit immediately, so an
    // unattended map grows without bound. This repo reached 512 rows of which
    // 510 were dead, which is what let a recycled pid resolve to a long-gone
    // agent.
    for (let i = 0; i < 260; i++) seedRow(30000 + i, "ghost-instance");
    writePidmapRow(root, process.pid, "live-instance", "claude_code");

    const rows = readdirSync(pidmapDir);
    expect(rows.length).toBeLessThan(260);
    expect(rows).toContain(String(process.pid));
  });

  test("stays idempotent for an unchanged row", () => {
    writePidmapRow(root, process.pid, "live-instance", "claude_code");
    writePidmapRow(root, process.pid, "live-instance", "claude_code");
    expect(readdirSync(pidmapDir)).toEqual([String(process.pid)]);
  });
});

describe("instanceHasLivePid", () => {
  test("sees our own live pid", () => {
    seedRow(process.pid, "live-instance");
    expect(instanceHasLivePid(root, "live-instance")).toBe(true);
  });

  test("reports no live pid when every row is stale", () => {
    seedRow(deadPid(), "ghost-instance");
    expect(instanceHasLivePid(root, "ghost-instance")).toBe(false);
  });
});
