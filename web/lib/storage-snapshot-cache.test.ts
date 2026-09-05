import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "../../src/core/storage/catalog";
import { inventoryStorage } from "../../src/core/storage/inventory";
import { clearStorageFootprintCache, readStorageFootprint } from "./storage-reader";
import { STORAGE_SNAPSHOT_MAX_AGE_MS, storageSnapshotPath } from "./storage-snapshot-cache";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harnery-storage-restart-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  writeFileSync(join(root, ".harnery", "config.jsonc"), "{}");
  return root;
}
const scan = (root: string) =>
  inventoryStorage(createStorageCatalog({ coord_root: root, project_root: root }));
afterEach(() => {
  clearStorageFootprintCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("persistent storage display cache", () => {
  test("coalesces concurrent cold requests even when project roots interleave", async () => {
    const a = fixture();
    const b = fixture();
    const inventories = new Map([
      [a, await scan(a)],
      [b, await scan(b)],
    ]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = new Map<string, number>();
    const options = {
      inventoryReader: async (root: string) => {
        calls.set(root, (calls.get(root) ?? 0) + 1);
        await gate;
        return inventories.get(root)!;
      },
    };
    const pending = [
      readStorageFootprint(a, options),
      readStorageFootprint(b, options),
      readStorageFootprint(a, options),
    ];
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const reports = await Promise.all(pending);
    expect(calls.get(a)).toBe(1);
    expect(calls.get(b)).toBe(1);
    expect(reports[0]).toBe(reports[2]);
  });

  test("checksum-valid malformed nested display fields trigger reconstruction", async () => {
    const root = fixture();
    await readStorageFootprint(root, { inventoryReader: scan });
    const original = readFileSync(storageSnapshotPath(root), "utf8");
    let reads = 0;
    for (const field of ["provenance", "reason", "missing-family", "duplicate-family"]) {
      const envelope = JSON.parse(original);
      const inventory = JSON.parse(envelope.body);
      if (field === "provenance") {
        const family = inventory.families.find(
          (row: { log_storage?: { effective_policy?: unknown } }) =>
            row.log_storage?.effective_policy,
        );
        family.log_storage.effective_policy.provenance = {};
      } else if (field === "missing-family") {
        inventory.families.pop();
      } else if (field === "duplicate-family") {
        inventory.families[0] = inventory.families[1];
      } else {
        inventory.families[0].maintenance.reason_code = 42;
      }
      envelope.body = JSON.stringify(inventory);
      envelope.sha256 = createHash("sha256").update(envelope.body).digest("hex");
      writeFileSync(storageSnapshotPath(root), JSON.stringify(envelope));
      clearStorageFootprintCache();
      await readStorageFootprint(root, {
        inventoryReader: (r) => {
          reads++;
          return scan(r);
        },
      });
    }
    expect(reads).toBe(4);
  });

  test("reuses the snapshot after process cache loss without a new inventory", async () => {
    const root = fixture();
    const first = await readStorageFootprint(root, { inventoryReader: scan });
    clearStorageFootprintCache();
    const second = await readStorageFootprint(root, {
      inventoryReader: async () => {
        throw new Error("must not rescan");
      },
    });
    expect(second).toEqual(first);
    expect(
      createStorageCatalog({ coord_root: root })
        .familiesForPath(storageSnapshotPath(root))
        .map((f) => f.id),
    ).toEqual(["storage-dashboard-cache"]);
  });

  test("serves an expired persisted snapshot while one refresh is pending", async () => {
    const root = fixture();
    let clock = 1000;
    const first = await readStorageFootprint(root, {
      inventoryReader: scan,
      now: () => clock,
      cacheMs: 100,
    });
    clearStorageFootprintCache();
    clock = 1500;
    let finish!: (v: typeof first.inventory) => void;
    let calls = 0;
    const options = {
      now: () => clock,
      cacheMs: 100,
      inventoryReader: () => {
        calls++;
        return new Promise<typeof first.inventory>((resolve) => {
          finish = resolve;
        });
      },
    };
    expect(await readStorageFootprint(root, options)).toEqual(first);
    expect(await readStorageFootprint(root, options)).toEqual(first);
    expect(calls).toBe(1);
    finish(first.inventory);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  test("configuration changes and copied checkout snapshots trigger fresh reads", async () => {
    const root = fixture();
    await readStorageFootprint(root, { inventoryReader: scan });
    const other = fixture();
    mkdirSync(join(other, ".harnery", "cache", "storage-footprint"), { recursive: true });
    copyFileSync(storageSnapshotPath(root), storageSnapshotPath(other));
    let calls = 0;
    const inventoryReader = (r: string) => {
      calls++;
      return scan(r);
    };
    await readStorageFootprint(other, { inventoryReader });
    expect(calls).toBe(1);
    clearStorageFootprintCache();
    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      JSON.stringify({
        logs: { storage: { families: { "web-performance-log": { max_bytes: 12345678 } } } },
      }),
    );
    await readStorageFootprint(root, { inventoryReader });
    expect(calls).toBe(2);
  });

  test("corrupt, structurally invalid, oversized, expired and future snapshots are discarded", async () => {
    const root = fixture();
    await readStorageFootprint(root, { inventoryReader: scan, now: () => 1000 });
    const original = JSON.parse(readFileSync(storageSnapshotPath(root), "utf8"));
    let calls = 0;
    for (const mutation of [
      () => "{broken",
      () => JSON.stringify({ ...original, body: "{}" }),
      () =>
        JSON.stringify({
          ...original,
          body: "{}",
          sha256: createHash("sha256").update("{}").digest("hex"),
        }),
      () => " ".repeat(4 * 1024 * 1024 + 1),
      () => JSON.stringify({ ...original, savedAt: 2000 }),
      () => JSON.stringify({ ...original, savedAt: 1000 - STORAGE_SNAPSHOT_MAX_AGE_MS - 1 }),
    ]) {
      clearStorageFootprintCache();
      writeFileSync(storageSnapshotPath(root), mutation());
      await readStorageFootprint(root, {
        now: () => 1000,
        inventoryReader: (r) => {
          calls++;
          return scan(r);
        },
      });
    }
    expect(calls).toBe(6);
  });

  test("a failed cache write cannot fail the fresh inventory and disabled caching bypasses disk", async () => {
    const root = fixture();
    writeFileSync(join(root, ".harnery", "cache"), "not a directory");
    const first = await readStorageFootprint(root, { inventoryReader: scan });
    expect(first.inventory.schema).toBe("harnery.storage-inventory/v2");
    let calls = 0;
    await readStorageFootprint(root, {
      inventoryReader: (r) => {
        calls++;
        return scan(r);
      },
      cacheMs: 0,
    });
    expect(calls).toBe(1);
  });

  test("a failed refresh preserves the last usable display snapshot", async () => {
    const root = fixture();
    const first = await readStorageFootprint(root, {
      inventoryReader: scan,
      now: () => 1000,
      cacheMs: 100,
    });
    clearStorageFootprintCache();
    const options = {
      now: () => 2000,
      cacheMs: 100,
      inventoryReader: async () => {
        throw new Error("unavailable");
      },
    };
    expect(await readStorageFootprint(root, options)).toEqual(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await readStorageFootprint(root, options)).toEqual(first);
  });
});
