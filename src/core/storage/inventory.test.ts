import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harneryStorageFamilies } from "./builtins.ts";
import { createStorageCatalog } from "./catalog.ts";
import {
  HARNERY_STORAGE_INVENTORY_SCHEMA,
  type HarneryStorageFamily,
  type HarneryStorageRoot,
} from "./contract.ts";
import { filterStorageInventory, inventoryStorage } from "./inventory.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage inventory", () => {
  test("streams the complete coordination root without following symlinks or reading bodies", async () => {
    const root = fixture();
    const storage = join(root, ".harnery");
    mkdirSync(join(storage, "work"), { recursive: true });
    writeFileSync(join(storage, "work", "known.json"), "known-body");
    writeFileSync(join(storage, "unknown.bin"), "unknown-body");
    const outside = fixture();
    writeFileSync(join(outside, "private.txt"), "must-not-count");
    symlinkSync(outside, join(storage, "work", "escape"), "dir");
    const report = await inventoryStorage(createStorageCatalog({ coord_root: root }), {
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      allocatedBytes: () => undefined,
    });
    expect(report.schema).toBe(HARNERY_STORAGE_INVENTORY_SCHEMA);
    expect(report.privacy).toEqual({ content_read: false, path_mode: "aggregate-labels" });
    expect(report.scan).toMatchObject({ mode: "streaming-lstat", max_concurrency: 16 });
    expect(report.filesystem_totals.regular_files).toEqual({
      state: "observed",
      unit: "files",
      value: 2,
    });
    expect(report.filesystem_totals.allocated_bytes).toEqual({
      state: "unavailable",
      unit: "bytes",
      reason_code: "allocated_bytes_unavailable",
    });
    expect(report.scope_totals.registered_external_roots.regular_files).toMatchObject({ value: 0 });
    expect(report.issues).toContainEqual({
      reason_code: "symlink_rejected",
      count: 1,
      maintenance_eligible: false,
    });
    expect(report.issues).toContainEqual({
      reason_code: "unregistered_path",
      count: 1,
      maintenance_eligible: false,
    });
    expect(family(report, "work-item-history").totals.regular_files).toEqual({
      state: "observed",
      unit: "files",
      value: 1,
    });
    expect(JSON.stringify(report)).not.toContain("private.txt");
    expect(JSON.stringify(report)).not.toContain(outside);
  });

  test("reports missing and wrong-type roots without creating dormant storage", async () => {
    const missing = fixture();
    const missingReport = await inventoryStorage(createStorageCatalog({ coord_root: missing }));
    expect(family(missingReport, "coord-message-inbox")).toMatchObject({
      state: "dormant",
      reason_codes: ["root_dormant"],
    });
    expect(await Bun.file(join(missing, ".harnery", "inbox")).exists()).toBeFalse();
    const wrong = fixture();
    mkdirSync(join(wrong, ".harnery"));
    writeFileSync(join(wrong, ".harnery", "inbox"), "not-a-directory");
    const wrongReport = await inventoryStorage(createStorageCatalog({ coord_root: wrong }));
    expect(family(wrongReport, "coord-message-inbox")).toMatchObject({
      state: "unavailable",
      reason_codes: ["wrong_root_type"],
      maintenance: { state: "ineligible" },
    });
  });

  test("inventories local delegated-maintenance objects but not delegated external sources", async () => {
    const root = fixture();
    mkdirSync(join(root, ".harnery", "artifacts", "one"), { recursive: true });
    writeFileSync(join(root, ".harnery", "artifacts", "one", "payload.bin"), "artifact");
    const report = await inventoryStorage(createStorageCatalog({ coord_root: root }));
    expect(family(report, "managed-artifacts")).toMatchObject({
      inventory: "filesystem",
      maintenance: { state: "delegated", reason_code: "maintenance_delegated" },
      totals: { regular_files: { state: "observed", value: 1, unit: "files" } },
    });
    expect(family(report, "adapter-native-conversations")).toMatchObject({
      state: "delegated",
      totals: {
        regular_files: {
          state: "unavailable",
          unit: "files",
          reason_code: "delegated_inventory_unavailable",
        },
      },
    });
  });

  test("filters stable family rows without changing complete filesystem totals", async () => {
    const root = fixture();
    mkdirSync(join(root, ".harnery"));
    writeFileSync(join(root, ".harnery", "config.jsonc"), "{}");
    const report = await inventoryStorage(createStorageCatalog({ coord_root: root }));
    const filtered = filterStorageInventory(report, {
      family_id: "project-configuration",
      storage_class: "durable-object-history",
    });
    expect(filtered.filter).toEqual({
      family_id: "project-configuration",
      storage_class: "durable-object-history",
    });
    expect(filtered.families.map(({ family_id }) => family_id)).toEqual(["project-configuration"]);
    expect(filtered.filesystem_totals).toEqual(report.filesystem_totals);
  });

  test("keeps every inactive storage maintenance policy ineligible", async () => {
    const report = await inventoryStorage(createStorageCatalog({ coord_root: fixture() }));
    expect(report.families.filter(({ maintenance }) => maintenance.state === "eligible")).toEqual(
      [],
    );
    expect(family(report, "agent-operational-log").maintenance).toEqual({
      state: "ineligible",
      reason_code: "maintenance_policy_inactive",
    });
  });

  test("rejects a boundary whose realpath target identity changes", async () => {
    const root = fixture();
    const boundary = join(root, ".host", "race");
    mkdirSync(boundary, { recursive: true });
    writeFileSync(join(boundary, "inside.json"), "inside");
    const outside = fixture();
    writeFileSync(join(outside, "private.json"), "outside");
    const report = await inventoryStorage(
      createStorageCatalog(
        { coord_root: root },
        { families: [hostFamily("race-history", [subtreeRoot(boundary)])] },
      ),
      {
        fs: {
          realpath: (path) =>
            resolve(path) === resolve(boundary) ? Promise.resolve(outside) : realpath(path),
        },
      },
    );
    expect(report.scope_totals.registered_external_roots.regular_files).toMatchObject({ value: 0 });
    expect(family(report, "race-history")).toMatchObject({
      state: "unavailable",
      reason_codes: ["symlink_rejected"],
    });
    expect(report.issues).toContainEqual({
      reason_code: "symlink_rejected",
      count: 1,
      maintenance_eligible: false,
    });
  });

  test("accepts a safe boundary reached through a symlinked parent", async () => {
    const actualParent = fixture();
    const actualProject = join(actualParent, "project");
    mkdirSync(join(actualProject, ".harnery"), { recursive: true });
    writeFileSync(join(actualProject, ".harnery", "config.jsonc"), "{}");
    const linkContainer = fixture();
    const linkedParent = join(linkContainer, "linked-parent");
    symlinkSync(actualParent, linkedParent, "dir");
    const report = await inventoryStorage(
      createStorageCatalog({ coord_root: join(linkedParent, "project") }),
    );
    expect(family(report, "project-configuration").totals.regular_files).toMatchObject({
      value: 1,
    });
    expect(report.issues.some(({ reason_code }) => reason_code === "symlink_rejected")).toBeFalse();
  });

  test("collapses nested external boundaries before counting", async () => {
    const root = fixture();
    const parent = join(root, ".host", "objects");
    const child = join(parent, "history");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(child, "one.json"), "one");
    const report = await inventoryStorage(
      createStorageCatalog(
        { coord_root: root },
        {
          families: [
            hostFamily("nested-history", [
              { path: parent, kind: "directory", match: "exact", ownership: "host" },
              subtreeRoot(child),
            ]),
          ],
        },
      ),
    );
    expect(report.scope_totals.registered_external_roots.regular_files).toMatchObject({ value: 1 });
    expect(family(report, "nested-history").totals.regular_files).toMatchObject({ value: 1 });
  });

  test("reports unsafe allocated byte values as unavailable", async () => {
    const root = fixture();
    mkdirSync(join(root, ".harnery"));
    writeFileSync(join(root, ".harnery", "config.jsonc"), "{}");
    const report = await inventoryStorage(createStorageCatalog({ coord_root: root }), {
      allocatedBytes: () => Number.MAX_SAFE_INTEGER + 1,
    });
    expect(report.filesystem_totals.allocated_bytes).toEqual({
      state: "unavailable",
      unit: "bytes",
      reason_code: "allocated_bytes_unavailable",
    });
  });

  test("marks hard-link allocation ambiguous and maintenance-ineligible", async () => {
    const root = fixture();
    const work = join(root, ".harnery", "work");
    mkdirSync(work, { recursive: true });
    const first = join(work, "first.json");
    writeFileSync(first, "shared");
    linkSync(first, join(work, "second.json"));
    const report = await inventoryStorage(createStorageCatalog({ coord_root: root }));
    expect(report.filesystem_totals.allocated_bytes).toEqual({
      state: "unavailable",
      unit: "bytes",
      reason_code: "allocated_bytes_unavailable",
    });
    expect(report.issues).toContainEqual({
      reason_code: "hard_link_ambiguous",
      count: 2,
      maintenance_eligible: false,
    });
    expect(family(report, "work-item-history")).toMatchObject({
      reason_codes: ["allocated_bytes_unavailable", "hard_link_ambiguous"],
      maintenance: { state: "ineligible" },
    });
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-storage-inventory-"));
  roots.push(root);
  return root;
}

function family(report: Awaited<ReturnType<typeof inventoryStorage>>, id: string) {
  const result = report.families.find(({ family_id }) => family_id === id);
  if (!result) throw new Error(`missing family ${id}`);
  return result;
}

function subtreeRoot(path: string): HarneryStorageRoot {
  return { path, kind: "directory", match: "subtree", ownership: "host" };
}

function hostFamily(id: string, roots: readonly HarneryStorageRoot[]): HarneryStorageFamily {
  const source = harneryStorageFamilies().find(
    (candidate) => candidate.id === "work-item-history",
  )!;
  return {
    ...source,
    id,
    owner: "fixture host",
    roots: () => roots,
    provider: { ...source.provider, provider_id: `${id}-provider`, inventory: "filesystem" },
  };
}
