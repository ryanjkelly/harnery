import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  instanceHasLivePid,
  parsePidmapRow,
  prunePidmapDeadRows,
  writePidmapRow,
} from "./pidmap.ts";

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

/** A row in the pre-token two-field shape, as every existing map holds today. */
function seedRow(pid: number, instanceId: string): void {
  writeFileSync(join(pidmapDir, String(pid)), `${instanceId}\tclaude_code`, "utf8");
}

/**
 * A row claiming this pid on behalf of a process that has since exited: the pid
 * is alive, but it belongs to somebody else now. This is the shape a liveness
 * probe cannot distinguish from a healthy row.
 */
function seedRecycledRow(pid: number, instanceId: string): void {
  writeFileSync(join(pidmapDir, String(pid)), `${instanceId}\tclaude_code\tl1`, "utf8");
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

  test("drops a row whose pid was re-issued to another process", () => {
    // The pid is alive — it is ours — so liveness alone would keep this row and
    // go on answering identity questions with a long-gone agent's name.
    seedRecycledRow(process.pid, "ghost-instance");

    expect(prunePidmapDeadRows(root)).toBe(1);
    expect(existsSync(join(pidmapDir, String(process.pid)))).toBe(false);
  });

  test("keeps a live row that carries a matching start token", () => {
    writePidmapRow(root, process.pid, "live-instance", "claude_code");
    expect(prunePidmapDeadRows(root)).toBe(0);
    expect(existsSync(join(pidmapDir, String(process.pid)))).toBe(true);
  });

  test("keeps a live pre-token row, since unverifiable is not the same as wrong", () => {
    seedRow(process.pid, "live-instance");
    expect(prunePidmapDeadRows(root)).toBe(0);
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

  test("stamps a start token that survives a round trip", () => {
    writePidmapRow(root, process.pid, "live-instance", "claude_code");
    const row = readFileSync(join(pidmapDir, String(process.pid)), "utf8");
    const parsed = parsePidmapRow(row);

    expect(parsed.instanceId).toBe("live-instance");
    expect(parsed.platform).toBe("claude_code");
    // Linux stamps ticks-since-boot; anywhere the platform will not say, the
    // field is empty and the row reads as unverifiable rather than wrong.
    if (existsSync("/proc/self/stat")) {
      expect(parsed.startToken).toMatch(/^l\d+$/);
    }
  });

  test("reads a pre-token row without inventing a token", () => {
    const parsed = parsePidmapRow("some-instance\tclaude_code");
    expect(parsed).toEqual({
      instanceId: "some-instance",
      platform: "claude_code",
      startToken: undefined,
    });
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

  test("a re-issued pid does not keep a departed agent looking alive", () => {
    // What this answer buys: the commit guard treats a live instance as a peer
    // whose claims block, and `identity assume` refuses to reclaim its name.
    seedRecycledRow(process.pid, "ghost-instance");
    expect(instanceHasLivePid(root, "ghost-instance")).toBe(false);
  });

  test("one good row outweighs a recycled one for the same instance", () => {
    seedRecycledRow(deadPid(), "live-instance");
    writePidmapRow(root, process.pid, "live-instance", "claude_code");
    expect(instanceHasLivePid(root, "live-instance")).toBe(true);
  });
});
