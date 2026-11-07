import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "../../src/core/storage/catalog";
import type { HarneryStorageInventoryReport } from "../../src/core/storage/contract";
import { inventoryStorage } from "../../src/core/storage/inventory";
import {
  clearStorageFootprintCache,
  readStorageFootprint,
  readStorageFootprintState,
  refreshStorageFootprint,
} from "./storage-reader";
import { storageRefreshLeasePath, storageSnapshotPath } from "./storage-snapshot-cache";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harnery-storage-state-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  writeFileSync(join(root, ".harnery", "config.jsonc"), "{}");
  return root;
}
const scan = (root: string) =>
  inventoryStorage(createStorageCatalog({ coord_root: root, project_root: root }));
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** An inventory reader whose walks finish only when the test says so. */
function gatedReader() {
  const waiting: Array<() => void> = [];
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    finishAll: () => {
      for (const finish of waiting.splice(0)) finish();
    },
    reader: (root: string) => {
      calls++;
      return new Promise<HarneryStorageInventoryReport>((resolve) => {
        waiting.push(() => resolve(scan(root)));
      });
    },
  };
}

afterEach(() => {
  clearStorageFootprintCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("non-blocking storage footprint state", () => {
  test("a cold cache reports measuring at once and starts exactly one walk", async () => {
    const root = fixture();
    const gate = gatedReader();
    const first = await readStorageFootprintState(root, { inventoryReader: gate.reader });
    expect(first.status).toBe("measuring");
    const second = await readStorageFootprintState(root, { inventoryReader: gate.reader });
    expect(second.status).toBe("measuring");
    expect(gate.calls).toBe(1);
    expect(existsSync(storageRefreshLeasePath(root))).toBe(true);

    gate.finishAll();
    await tick();
    const ready = await readStorageFootprintState(root, { inventoryReader: gate.reader });
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") return;
    expect(ready.stale).toBe(false);
    expect(ready.refreshing).toBe(false);
    expect(ready.settingsChanged).toBe(false);
    expect(gate.calls).toBe(1);
    expect(existsSync(storageRefreshLeasePath(root))).toBe(false);
    // Fresh numbers are the same report the blocking reader would serve.
    expect(await readStorageFootprint(root)).toBe(ready.report);
  });

  test("an old measurement is served at once while one background walk runs", async () => {
    const root = fixture();
    let clock = 1_000;
    await readStorageFootprint(root, { inventoryReader: scan, now: () => clock, cacheMs: 100 });
    clearStorageFootprintCache();
    clock = 5_000;
    const gate = gatedReader();
    const options = { inventoryReader: gate.reader, now: () => clock, cacheMs: 100 };
    const stale = await readStorageFootprintState(root, options);
    expect(stale.status).toBe("ready");
    if (stale.status !== "ready") return;
    expect(stale.stale).toBe(true);
    expect(stale.refreshing).toBe(true);
    expect(stale.measuredAt).toBe(1_000);
    await readStorageFootprintState(root, options);
    expect(gate.calls).toBe(1);

    gate.finishAll();
    await tick();
    const fresh = await readStorageFootprintState(root, options);
    expect(fresh.status === "ready" && !fresh.stale && !fresh.refreshing).toBe(true);
    expect(fresh.status === "ready" && fresh.measuredAt).toBe(5_000);
  });

  test("changed settings show the previous measurement as stale while measuring again", async () => {
    const root = fixture();
    await readStorageFootprint(root, { inventoryReader: scan });
    clearStorageFootprintCache();
    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      JSON.stringify({
        logs: { storage: { families: { "web-performance-log": { max_bytes: 12345678 } } } },
      }),
    );
    const gate = gatedReader();
    const state = await readStorageFootprintState(root, { inventoryReader: gate.reader });
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.settingsChanged).toBe(true);
    expect(state.stale).toBe(true);
    expect(state.refreshing).toBe(true);
    expect(gate.calls).toBe(1);
    gate.finishAll();
    await tick();
  });

  test("a snapshot belonging to another checkout is never shown", async () => {
    const root = fixture();
    await readStorageFootprint(root, { inventoryReader: scan });
    const other = fixture();
    mkdirSync(join(other, ".harnery", "cache", "storage-footprint"), { recursive: true });
    copyFileSync(storageSnapshotPath(root), storageSnapshotPath(other));
    const gate = gatedReader();
    const state = await readStorageFootprintState(other, { inventoryReader: gate.reader });
    expect(state.status).toBe("measuring");
    gate.finishAll();
    await tick();
  });

  test("a failed first walk backs off until the retry window or a forced walk", async () => {
    const root = fixture();
    let clock = 10_000;
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("disk unavailable");
    };
    const options = { inventoryReader: failing, now: () => clock, retryMs: 1_000 };
    expect((await readStorageFootprintState(root, options)).status).toBe("measuring");
    await tick();
    const failed = await readStorageFootprintState(root, options);
    expect(failed.status).toBe("failed");
    if (failed.status !== "failed") return;
    expect(failed.failure.message).toBe("disk unavailable");
    expect(failed.retryAt).toBe(11_000);
    expect(calls).toBe(1);

    expect((await readStorageFootprintState(root, { ...options, force: true })).status).toBe(
      "measuring",
    );
    await tick();
    expect(calls).toBe(2);

    clock = 12_000;
    expect((await readStorageFootprintState(root, options)).status).toBe("measuring");
    await tick();
    expect(calls).toBe(3);
  });

  test("a walk held by another live dashboard process is not duplicated", async () => {
    const root = fixture();
    mkdirSync(join(root, ".harnery", "cache", "storage-footprint"), { recursive: true });
    writeFileSync(
      storageRefreshLeasePath(root),
      JSON.stringify({ pid: process.ppid, startedAt: Date.now(), token: "peer" }),
    );
    const gate = gatedReader();
    const state = await readStorageFootprintState(root, { inventoryReader: gate.reader });
    expect(state.status).toBe("measuring");
    expect(gate.calls).toBe(0);
    expect(await refreshStorageFootprint(root, { inventoryReader: gate.reader })).toEqual({
      status: "elsewhere",
    });
    expect(gate.calls).toBe(0);
  });

  test("a lease left by an exited process is reclaimed", async () => {
    const root = fixture();
    mkdirSync(join(root, ".harnery", "cache", "storage-footprint"), { recursive: true });
    writeFileSync(
      storageRefreshLeasePath(root),
      JSON.stringify({ pid: 2 ** 22 + 17, startedAt: Date.now(), token: "gone" }),
    );
    const gate = gatedReader();
    expect((await readStorageFootprintState(root, { inventoryReader: gate.reader })).status).toBe(
      "measuring",
    );
    expect(gate.calls).toBe(1);
    gate.finishAll();
    await tick();
  });

  test("Measure now waits for the walk; a fresh measurement returns without walking", async () => {
    const root = fixture();
    let calls = 0;
    const reader = (r: string) => {
      calls++;
      return scan(r);
    };
    const measured = await refreshStorageFootprint(root, { inventoryReader: reader });
    expect(measured.status).toBe("measured");
    expect(calls).toBe(1);
    const fresh = await refreshStorageFootprint(root, { inventoryReader: reader });
    expect(fresh.status).toBe("fresh");
    expect(calls).toBe(1);
    const forced = await refreshStorageFootprint(root, { inventoryReader: reader, force: true });
    expect(forced.status).toBe("measured");
    expect(calls).toBe(2);
  });
});
