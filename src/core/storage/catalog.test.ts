import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { harneryStorageFamilies } from "./builtins.ts";
import { createStorageCatalog, HarneryStorageCatalogError } from "./catalog.ts";
import type { HarneryStorageFamily } from "./contract.ts";

const ROOT = "/tmp/harnery-storage-catalog-test";

function hostFamily(id: string, relativeRoot: string): HarneryStorageFamily {
  const source = harneryStorageFamilies().find((family) => family.id === "work-item-history")!;
  return {
    ...source,
    id,
    owner: "fixture host",
    roots: (context) => [
      {
        path: join(context.coord_root, relativeRoot),
        kind: "directory",
        match: "subtree",
        ownership: "host",
      },
    ],
    provider: { ...source.provider, provider_id: `${id}-provider` },
  };
}

describe("storage catalog", () => {
  test("combines source-owned and construction-time host families", () => {
    const catalog = createStorageCatalog(
      { coord_root: ROOT },
      {
        families: [hostFamily("host-history", ".host/history")],
        logger_bindings: [{ component_id: "host-worker", family_id: "agent-operational-log" }],
        exclusions: [
          {
            owner: "host database",
            root: {
              path: join(ROOT, ".host/database"),
              kind: "directory",
              match: "subtree",
              ownership: "host",
            },
            reason: "database owns its transaction lifecycle",
            external_lifecycle_authority: "host database transaction manager",
          },
        ],
      },
    );
    expect(catalog.require("host-history").source).toBe("host");
    expect(catalog.require("event-v3-canonical-active").source).toBe("harnery");
    expect(Object.isFrozen(catalog.require("event-v3-canonical-active").policy)).toBeTrue();
    expect(catalog.logger_bindings).toHaveLength(1);
    expect(catalog.exclusions).toHaveLength(1);
  });

  test("rejects replacement of a Harnery descriptor", () => {
    expect(() =>
      createStorageCatalog(
        { coord_root: ROOT },
        { families: [hostFamily("coord-message-inbox", ".host/inbox")] },
      ),
    ).toThrow("cannot replace or weaken a Harnery descriptor");
  });

  test("rejects duplicate host IDs and overlapping roots", () => {
    expect(() =>
      createStorageCatalog(
        { coord_root: ROOT },
        {
          families: [hostFamily("host-one", ".host/shared"), hostFamily("host-one", ".host/other")],
        },
      ),
    ).toThrow("duplicate storage family id");
    expect(() =>
      createStorageCatalog(
        { coord_root: ROOT },
        {
          families: [
            hostFamily("host-one", ".host/shared"),
            hostFamily("host-two", ".host/shared/nested"),
          ],
        },
      ),
    ).toThrow("overlapping storage roots");
  });

  test("rejects differently labeled provider partitions with overlapping globs", () => {
    const provider = {
      provider_id: "host-partition-provider",
      kind: "filesystem" as const,
      inventory: "filesystem" as const,
      maintenance: "none" as const,
      lifecycle_authority: "fixture classifier",
      partitions: ["first", "second"],
    };
    const partitioned = (id: string, partition: string, include: string) => ({
      ...hostFamily(id, `.host/${id}`),
      roots: (context: { coord_root: string }) => [
        {
          path: join(context.coord_root, ".host/partitioned"),
          kind: "directory" as const,
          match: "provider-partition" as const,
          partition,
          include: [include],
          ownership: "host" as const,
        },
      ],
      provider,
    });
    expect(() =>
      createStorageCatalog(
        { coord_root: ROOT },
        {
          families: [
            partitioned("host-first", "first", "logs/**"),
            partitioned("host-second", "second", "logs/*.jsonl"),
          ],
        },
      ),
    ).toThrow("overlapping storage roots");
  });

  test("rejects unknown and non-log logger bindings", () => {
    expect(() =>
      createStorageCatalog(
        { coord_root: ROOT },
        { logger_bindings: [{ component_id: "worker", family_id: "missing" }] },
      ),
    ).toThrow("unknown family");
    expect(() =>
      createStorageCatalog(
        { coord_root: ROOT },
        { logger_bindings: [{ component_id: "worker", family_id: "work-item-history" }] },
      ),
    ).toThrow("non-log family");
  });

  test("rejects exclusions that hide registered or non-host paths", () => {
    const exclusion = {
      owner: "fixture",
      root: {
        path: join(ROOT, ".harnery/work"),
        kind: "directory" as const,
        match: "subtree" as const,
        ownership: "host" as const,
      },
      reason: "fixture",
      external_lifecycle_authority: "fixture",
    };
    expect(() => createStorageCatalog({ coord_root: ROOT }, { exclusions: [exclusion] })).toThrow(
      "overlaps registered family",
    );
    expect(() =>
      createStorageCatalog(
        { coord_root: ROOT },
        {
          exclusions: [{ ...exclusion, root: { ...exclusion.root, ownership: "external" } }],
        },
      ),
    ).toThrow(HarneryStorageCatalogError);
  });
});
