import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { harneryStorageFamilies } from "./builtins.ts";
import { createStorageCatalog } from "./catalog.ts";
import type { HarneryStorageFamily } from "./contract.ts";
import {
  HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
  runAutomaticMaintenanceSlice,
  writePressureSummary,
} from "./maintenance.ts";
import {
  createAutomaticMaintenanceComposition,
  createExistingMaintenanceProviders,
  createStructuredLogMaintenanceProviders,
  runAutomaticMaintenancePass,
} from "./maintenance-providers.ts";
import {
  HARNERY_RETIRED_ROOTS,
  HarneryRetirementError,
  listRetiredRoots,
  previewStorageRetirement,
  retireStorageRoot,
} from "./retire.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harnery-retire-")));
  roots.push(root);
  mkdirSync(join(root, ".harnery"));
  return root;
}

function seedRetired(root: string, name = "work"): string {
  const dir = join(root, ".harnery", name);
  mkdirSync(join(dir, "items", "one"), { recursive: true });
  writeFileSync(join(dir, "items", "one", "record.json"), '{"id":"one"}');
  writeFileSync(join(dir, "index.json"), "[]");
  return dir;
}

const noClaims = { peerClaims: () => [] };

function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string) => {
    const info = lstatSync(path);
    const key = relative(dir, path) || ".";
    if (info.isDirectory()) {
      result[key] = `dir:${info.mtimeMs}`;
      for (const child of readdirSync(path)) walk(join(path, child));
    } else if (info.isSymbolicLink()) result[key] = "link";
    else result[key] = `${info.mtimeMs}:${readFileSync(path, "utf8")}`;
  };
  walk(dir);
  return result;
}

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof HarneryRetirementError) return error.code;
    throw error;
  }
  return "no-error";
}

describe("storage retire", () => {
  test("lists the five retired roots with existence and counts, read-only", () => {
    const root = workspace();
    const dir = seedRetired(root, "councils");
    const before = snapshot(dir);
    const report = listRetiredRoots(createStorageCatalog({ coord_root: root }));
    expect(report.roots.map((entry) => entry.name)).toEqual([
      "work",
      "governors",
      "governor-service",
      "councils",
      "mailbox",
    ]);
    expect(report.roots.every((entry) => entry.retired_by === "ADR 0238")).toBeTrue();
    expect(report.roots.find((entry) => entry.name === "councils")).toMatchObject({
      state: "present",
      files: 2,
      bytes: 14,
    });
    expect(report.roots.find((entry) => entry.name === "work")?.state).toBe("absent");
    expect(snapshot(dir)).toEqual(before);
  });

  test("refuses an unlisted name, a nested path, traversal and an absolute path", () => {
    const root = workspace();
    seedRetired(root);
    mkdirSync(join(root, ".harnery", "journal"));
    const catalog = createStorageCatalog({ coord_root: root });
    for (const name of [
      "journal",
      "unknown",
      "work/items",
      "../work",
      "..",
      ".",
      "",
      join(root, ".harnery", "work"),
      "work\\items",
    ])
      expect(code(() => previewStorageRetirement(catalog, name, noClaims))).toBe(
        "not_a_retired_root",
      );
    expect(existsSync(join(root, ".harnery", "work", "index.json"))).toBeTrue();
  });

  test("refuses a symlinked folder and a symlinked .harnery", () => {
    const root = workspace();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "keep");
    symlinkSync(elsewhere, join(root, ".harnery", "work"));
    const catalog = createStorageCatalog({ coord_root: root });
    expect(code(() => previewStorageRetirement(catalog, "work", noClaims))).toBe("unsafe_path");

    const linked = realpathSync(mkdtempSync(join(tmpdir(), "harnery-retire-linked-")));
    roots.push(linked);
    const realState = join(root, "real-state");
    mkdirSync(join(realState, "mailbox"), { recursive: true });
    symlinkSync(realState, join(linked, ".harnery"));
    expect(
      code(() =>
        previewStorageRetirement(createStorageCatalog({ coord_root: linked }), "mailbox", noClaims),
      ),
    ).toBe("unsafe_path");
    expect(existsSync(join(elsewhere, "keep.txt"))).toBeTrue();
    expect(existsSync(join(realState, "mailbox"))).toBeTrue();
  });

  test("removes a link inside the folder as a link and leaves its target alone", () => {
    const root = workspace();
    const dir = seedRetired(root);
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious.txt"), "precious");
    symlinkSync(outside, join(dir, "items", "link-to-outside"));
    const catalog = createStorageCatalog({ coord_root: root });
    const preview = previewStorageRetirement(catalog, "work", noClaims);
    expect(preview.links).toEqual([{ path: "items/link-to-outside", target: outside }]);
    expect(preview.files).toBe(2);
    const result = retireStorageRoot(catalog, "work", {
      ...noClaims,
      yes: true,
      inventory_sha256: preview.inventory_sha256!,
    });
    expect(result.outcome).toBe("retired");
    expect(existsSync(dir)).toBeFalse();
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("precious");
  });

  test("refuses overlap with a catalog root, including a host root nested inside", () => {
    const root = workspace();
    seedRetired(root, "work");
    seedRetired(root, "mailbox");
    const nested = createStorageCatalog(
      { coord_root: root },
      { families: [hostFamily("host-nested", join(root, ".harnery", "work", "items"))] },
    );
    expect(code(() => previewStorageRetirement(nested, "work", noClaims))).toBe(
      "storage_root_overlap",
    );
    const equal = createStorageCatalog(
      { coord_root: root },
      { families: [hostFamily("host-equal", join(root, ".harnery", "mailbox"))] },
    );
    expect(code(() => previewStorageRetirement(equal, "mailbox", noClaims))).toBe(
      "storage_root_overlap",
    );
    const excluded = createStorageCatalog(
      { coord_root: root },
      {
        exclusions: [
          {
            owner: "host-tool",
            reason: "kept by the host",
            external_lifecycle_authority: "host",
            root: {
              path: join(root, ".harnery", "mailbox", "keep"),
              kind: "directory",
              match: "subtree",
              ownership: "host",
            },
          },
        ],
      },
    );
    expect(code(() => previewStorageRetirement(excluded, "mailbox", noClaims))).toBe(
      "storage_root_overlap",
    );
    // A pattern root on .harnery that could reach the folder counts as overlap.
    const pattern = createStorageCatalog(
      { coord_root: root },
      {
        families: [
          {
            ...hostFamily("host-pattern", join(root, ".harnery")),
            roots: () => [
              {
                path: join(root, ".harnery"),
                kind: "directory",
                match: "pattern",
                include: ["mailbox/**"],
                ownership: "host",
              },
            ],
          },
        ],
      },
    );
    expect(code(() => previewStorageRetirement(pattern, "mailbox", noClaims))).toBe(
      "storage_root_overlap",
    );
    expect(existsSync(join(root, ".harnery", "work"))).toBeTrue();
    expect(existsSync(join(root, ".harnery", "mailbox"))).toBeTrue();
  });

  test("no built-in storage root overlaps any retired folder", () => {
    const root = workspace();
    const catalog = createStorageCatalog({ coord_root: root });
    for (const entry of HARNERY_RETIRED_ROOTS)
      expect(catalog.rootsOverlapping(join(root, ".harnery", entry.name))).toEqual([]);
  });

  test("refuses tracked content", () => {
    const root = workspace();
    const dir = seedRetired(root);
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: gitEnv() });
    expect(git("init", "-q").status).toBe(0);
    expect(git("add", "-f", join(dir, "index.json")).status).toBe(0);
    expect(
      code(() =>
        previewStorageRetirement(createStorageCatalog({ coord_root: root }), "work", noClaims),
      ),
    ).toBe("tracked_content");
    expect(existsSync(join(dir, "index.json"))).toBeTrue();
  });

  test("refuses Git metadata inside the folder", () => {
    const root = workspace();
    const dir = seedRetired(root);
    mkdirSync(join(dir, "copy", ".git"), { recursive: true });
    expect(
      code(() =>
        previewStorageRetirement(createStorageCatalog({ coord_root: root }), "work", noClaims),
      ),
    ).toBe("repository_metadata");
  });

  test("refuses a peer claim inside, on, or containing the folder", () => {
    const root = workspace();
    const dir = seedRetired(root);
    const catalog = createStorageCatalog({ coord_root: root });
    for (const claim of [".harnery/work/items/one/record.json", ".harnery/work", ".harnery"])
      expect(
        code(() => previewStorageRetirement(catalog, "work", { peerClaims: () => [claim] })),
      ).toBe("peer_claim");
    expect(
      code(() =>
        previewStorageRetirement(catalog, "work", { peerClaims: () => [".harnery/journal"] }),
      ),
    ).toBe("no-error");
    // Claims that cannot be read refuse rather than pass.
    expect(() =>
      previewStorageRetirement(catalog, "work", {
        peerClaims: () => {
          throw new Error("coordination state unavailable");
        },
      }),
    ).toThrow("coordination state unavailable");
    expect(existsSync(dir)).toBeTrue();
  });

  test("the preview leaves every file byte-identical", () => {
    const root = workspace();
    const dir = seedRetired(root);
    const before = snapshot(dir);
    const catalog = createStorageCatalog({ coord_root: root });
    const preview = previewStorageRetirement(catalog, "work", noClaims);
    const again = retireStorageRoot(catalog, "work", noClaims);
    expect(preview).toMatchObject({ outcome: "preview", applied: false, files: 2, bytes: 14 });
    expect(again.inventory_sha256).toBe(preview.inventory_sha256!);
    expect(preview.inventory_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot(dir)).toEqual(before);
  });

  test("refuses a missing or wrong digest, and a digest without --yes", () => {
    const root = workspace();
    const dir = seedRetired(root);
    const catalog = createStorageCatalog({ coord_root: root });
    const preview = previewStorageRetirement(catalog, "work", noClaims);
    expect(code(() => retireStorageRoot(catalog, "work", { ...noClaims, yes: true }))).toBe(
      "inventory_digest_required",
    );
    expect(
      code(() =>
        retireStorageRoot(catalog, "work", {
          ...noClaims,
          yes: true,
          inventory_sha256: "0".repeat(64),
        }),
      ),
    ).toBe("inventory_changed");
    expect(
      code(() =>
        retireStorageRoot(catalog, "work", {
          ...noClaims,
          inventory_sha256: preview.inventory_sha256!,
        }),
      ),
    ).toBe("confirmation_required");
    expect(existsSync(dir)).toBeTrue();
  });

  test("a file added after the preview causes a refusal", () => {
    const root = workspace();
    const dir = seedRetired(root);
    const catalog = createStorageCatalog({ coord_root: root });
    const preview = previewStorageRetirement(catalog, "work", noClaims);
    writeFileSync(join(dir, "items", "late.json"), "{}");
    expect(
      code(() =>
        retireStorageRoot(catalog, "work", {
          ...noClaims,
          yes: true,
          inventory_sha256: preview.inventory_sha256!,
        }),
      ),
    ).toBe("inventory_changed");
    expect(existsSync(join(dir, "items", "late.json"))).toBeTrue();
    expect(existsSync(join(dir, "index.json"))).toBeTrue();
  });

  test("refuses a folder over the entry limit", () => {
    const root = workspace();
    seedRetired(root);
    const catalog = createStorageCatalog({ coord_root: root });
    expect(
      code(() => previewStorageRetirement(catalog, "work", { ...noClaims, entryLimit: 3 })),
    ).toBe("entry_limit_exceeded");
    expect(previewStorageRetirement(catalog, "work", { ...noClaims, entryLimit: 5 }).outcome).toBe(
      "preview",
    );
  });

  test("removes the folder with the right counts, then reports already retired", () => {
    const root = workspace();
    const dir = seedRetired(root, "governors");
    const sibling = seedRetired(root, "mailbox");
    const catalog = createStorageCatalog({ coord_root: root });
    const preview = previewStorageRetirement(catalog, "governors", noClaims);
    const result = retireStorageRoot(catalog, "governors", {
      ...noClaims,
      yes: true,
      inventory_sha256: preview.inventory_sha256!,
    });
    expect(result).toMatchObject({
      outcome: "retired",
      applied: true,
      files: 2,
      directories: 3,
      bytes: 14,
      retired_by: "ADR 0238",
    });
    expect(existsSync(dir)).toBeFalse();
    expect(existsSync(join(sibling, "index.json"))).toBeTrue();
    for (const second of [
      retireStorageRoot(catalog, "governors", { ...noClaims, yes: true }),
      previewStorageRetirement(catalog, "governors", noClaims),
    ]) {
      expect(second).toMatchObject({ outcome: "already_retired", applied: false, files: 0 });
      expect(second.inventory_sha256).toBeUndefined();
    }
  });

  test("no automatic maintenance path touches a retired folder", async () => {
    const root = workspace();
    const dirs = HARNERY_RETIRED_ROOTS.map((entry) => seedRetired(root, entry.name));
    const before = dirs.map(snapshot);
    const catalog = createStorageCatalog({ coord_root: root, project_root: root });
    writePressureSummary(root, {
      schema: HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
      captured_at: new Date().toISOString(),
      families: catalog.families.map((family) => ({
        family_id: family.id,
        logical_bytes: 1_000_000_000,
        regular_files: 1_000_000,
        needs_maintenance: true,
        observed_at: new Date().toISOString(),
      })),
    });
    const janitors = { journal: () => {}, images: () => {}, artifacts: () => {} };
    await runAutomaticMaintenancePass(createAutomaticMaintenanceComposition(root, janitors));
    await runAutomaticMaintenanceSlice(
      catalog,
      [
        ...createExistingMaintenanceProviders(janitors),
        ...createStructuredLogMaintenanceProviders(catalog),
      ],
      { execute: true },
    );
    expect(dirs.map(snapshot)).toEqual(before);
    // Retirement is reachable only from its command: no other source module
    // imports the retirement module.
    const src = join(import.meta.dir, "..", "..");
    const importers = sourceFiles(src).filter((file) =>
      /from "[^"]*storage\/retire\.ts"|from "\.\/retire\.ts"/.test(readFileSync(file, "utf8")),
    );
    expect(importers.map((file) => relative(src, file).split("\\").join("/")).sort()).toEqual([
      "commands/storage.ts",
    ]);
  });
});

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
  };
}

function hostFamily(id: string, path: string): HarneryStorageFamily {
  const template = harneryStorageFamilies().find((family) => family.id === "decision-history")!;
  return {
    ...template,
    id,
    owner: "fixture host",
    roots: () => [{ path, kind: "directory", match: "subtree", ownership: "host" }],
    provider: { ...template.provider, provider_id: `${id}-provider`, inventory: "filesystem" },
  };
}
