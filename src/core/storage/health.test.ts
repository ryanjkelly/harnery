import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harneryStorageFamilies } from "./builtins.ts";
import { createStorageCatalog } from "./catalog.ts";
import { HARNERY_STORAGE_HEALTH_SCHEMA, type HarneryStorageFamily } from "./contract.ts";
import { storageHealth } from "./health.ts";
import { inventoryStorage } from "./inventory.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage health", () => {
  test("never calls dormant or delegated families healthy", async () => {
    const root = fixture();
    const report = storageHealth(
      await inventoryStorage(createStorageCatalog({ coord_root: root })),
    );
    expect(report.schema).toBe(HARNERY_STORAGE_HEALTH_SCHEMA);
    expect(report.status).toBe("unknown");
    expect(health(report, "coord-message-inbox")).toMatchObject({
      status: "unknown",
      reason_codes: ["root_dormant"],
    });
    expect(health(report, "adapter-native-conversations")).toMatchObject({
      status: "unknown",
      reason_codes: ["delegated_inventory_unavailable"],
    });
  });

  test("degrades on unregistered files while keeping reason codes stable", async () => {
    const root = fixture();
    mkdirSync(join(root, ".harnery"));
    writeFileSync(join(root, ".harnery", "unknown.bin"), "unknown");
    const report = storageHealth(
      await inventoryStorage(createStorageCatalog({ coord_root: root })),
    );
    expect(report.status).toBe("degraded");
    expect(report.reason_codes).toContain("unregistered_path");
    expect(report.issues).toContainEqual({
      reason_code: "unregistered_path",
      count: 1,
      maintenance_eligible: false,
    });
  });

  test("keeps a present plus dormant family unknown", async () => {
    const root = fixture();
    const present = join(root, ".host", "mixed", "present");
    const dormant = join(root, ".host", "mixed", "dormant");
    mkdirSync(present, { recursive: true });
    writeFileSync(join(present, "one.json"), "one");
    const report = storageHealth(
      await inventoryStorage(
        createStorageCatalog(
          { coord_root: root },
          { families: [hostFamily("mixed-history", [present, dormant])] },
        ),
      ),
    );
    expect(health(report, "mixed-history")).toMatchObject({
      status: "unknown",
      reason_codes: ["root_dormant"],
    });
  });

  test("treats explicit host exclusions as accepted accounting", async () => {
    const root = fixture();
    const excluded = join(root, ".harnery", "host-owned");
    mkdirSync(excluded, { recursive: true });
    writeFileSync(join(excluded, "one.db"), "host");
    const report = storageHealth(
      await inventoryStorage(
        createStorageCatalog(
          { coord_root: root },
          {
            exclusions: [
              {
                owner: "fixture host",
                root: {
                  path: excluded,
                  kind: "directory",
                  match: "subtree",
                  ownership: "host",
                },
                reason: "fixture host owns this lifecycle",
                external_lifecycle_authority: "fixture host",
              },
            ],
          },
        ),
      ),
    );
    expect(report.status).toBe("unknown");
    expect(report.issues).toContainEqual({
      reason_code: "host_exclusion",
      count: 1,
      maintenance_eligible: false,
    });
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-storage-health-"));
  roots.push(root);
  return root;
}

function health(report: ReturnType<typeof storageHealth>, familyId: string) {
  const row = report.families.find(({ family_id }) => family_id === familyId);
  if (!row) throw new Error(`missing family ${familyId}`);
  return row;
}

function hostFamily(id: string, roots: readonly string[]): HarneryStorageFamily {
  const source = harneryStorageFamilies().find(
    (candidate) => candidate.id === "work-item-history",
  )!;
  return {
    ...source,
    id,
    owner: "fixture host",
    roots: () =>
      roots.map((path) => ({
        path,
        kind: "directory",
        match: "subtree",
        ownership: "host",
      })),
    provider: { ...source.provider, provider_id: `${id}-provider`, inventory: "filesystem" },
  };
}
