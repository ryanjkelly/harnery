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
});
