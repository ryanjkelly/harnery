import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStorageCatalog } from "../../src/core/storage/catalog";
import { inventoryStorage } from "../../src/core/storage/inventory";
import {
  clearStorageFootprintCache,
  readStorageFootprint,
  summarizeStorageHealth,
} from "./storage-reader";

const roots: string[] = [];

afterEach(() => {
  clearStorageFootprintCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage footprint reader", () => {
  test("uses the canonical inventory and health reports without reading file bodies", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-web-storage-"));
    roots.push(root);
    mkdirSync(join(root, ".harnery", "active"), { recursive: true });
    writeFileSync(join(root, ".harnery", "config.jsonc"), "{}\n");
    writeFileSync(join(root, ".harnery", "active", "agent.json"), "not parsed by inventory\n");

    const inventoryReader = (sourceRoot: string) =>
      inventoryStorage(createStorageCatalog({ coord_root: sourceRoot, project_root: sourceRoot }));
    const report = await readStorageFootprint(root, { inventoryReader });

    expect(report.inventory.schema).toBe("harnery.storage-inventory/v2");
    expect(report.health.schema).toBe("harnery.storage-health/v2");
    expect(report.inventory.privacy).toEqual({
      content_read: false,
      path_mode: "aggregate-labels",
    });
    expect(report.catalog.familyCount).toBe(report.families.length);
    expect(report.catalog.rootCount).toBeGreaterThan(report.catalog.familyCount);
    expect(report.catalog.storageClassCount).toBe(report.classes.length);
    expect(report.classes.reduce((sum, row) => sum + row.families, 0)).toBe(
      report.catalog.familyCount,
    );
    expect(
      report.families.find(({ inventory }) => inventory.family_id === "project-configuration"),
    ).toMatchObject({ inventory: { state: "present" }, health: { status: "healthy" } });
    expect(
      report.families.find(({ inventory }) => inventory.family_id === "active-agent-projection"),
    ).toMatchObject({ inventory: { state: "present" } });
    const summary = summarizeStorageHealth(report.families);
    expect(summary.unknown).toBeGreaterThan(0);
    expect(summary.needsAttention).toBe(summary.degraded);
    expect(summary.needsAttention).toBe(0);

    const cached = await readStorageFootprint(root, { inventoryReader });
    expect(cached).toBe(report);
  });

  test("serves an expired snapshot immediately and refreshes it in the background", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-web-storage-"));
    roots.push(root);
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(join(root, ".harnery", "config.jsonc"), "{}\n");

    let reads = 0;
    let release: (() => void) | undefined;
    const inventoryReader = async (sourceRoot: string) => {
      reads += 1;
      if (reads > 1) await new Promise<void>((resolve) => (release = resolve));
      return inventoryStorage(
        createStorageCatalog({ coord_root: sourceRoot, project_root: sourceRoot }),
      );
    };
    let clock = 1_000;
    const options = { inventoryReader, cacheMs: 100, now: () => clock };

    const first = await readStorageFootprint(root, options);
    expect(reads).toBe(1);

    clock += 500;
    const stale = await readStorageFootprint(root, options);
    expect(stale).toBe(first);
    expect(reads).toBe(2);

    const again = await readStorageFootprint(root, options);
    expect(again).toBe(first);
    expect(reads).toBe(2);

    release?.();
    let fresh = first;
    for (let attempt = 0; attempt < 200 && fresh === first; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      fresh = await readStorageFootprint(root, options);
    }
    expect(fresh).not.toBe(first);
    expect(reads).toBe(2);
  });
});
