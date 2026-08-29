import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext } from "../commander.ts";
import { harneryStorageFamilies } from "../core/storage/builtins.ts";
import type {
  HarneryStorageFamily,
  HarneryStorageInventoryReport,
} from "../core/storage/contract.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage command", () => {
  test("is registered with inventory and health subcommands", () => {
    const storage = createHarneryProgram().commands.find((command) => command.name() === "storage");
    expect(storage).toBeDefined();
    expect(storage?.commands.map((command) => command.name()).sort()).toEqual([
      "health",
      "inventory",
    ]);
  }, 10_000);

  test("honors construction-time command exclusion", () => {
    expect(
      createHarneryProgram({ skipCommands: ["storage"] }).commands.find(
        (command) => command.name() === "storage",
      ),
    ).toBeUndefined();
  }, 10_000);

  test("uses construction-time host registration and stable JSON filters", async () => {
    const root = fixture();
    mkdirSync(join(root, ".harnery"));
    writeFileSync(join(root, ".harnery", "config.jsonc"), "{}");
    mkdirSync(join(root, ".host", "history"), { recursive: true });
    writeFileSync(join(root, ".host", "history", "one.json"), "host-history");
    const output = captureEmit();
    const program = createHarneryProgram({
      emit: output.emit,
      context: {
        repoRoot: root,
        storage: { families: [hostFamily()] },
      },
    });
    await program.parseAsync(["storage", "inventory", "--family", "host-history", "--json"], {
      from: "user",
    });
    const report = output.data[0] as HarneryStorageInventoryReport;
    expect(report.schema).toBe("harnery.storage-inventory/v1");
    expect(report.filter).toEqual({ family_id: "host-history" });
    expect(report.families).toHaveLength(1);
    expect(report.families[0]).toMatchObject({
      family_id: "host-history",
      source: "host",
      totals: { regular_files: { state: "observed", unit: "files", value: 1 } },
    });
    expect(report.filesystem_totals.regular_files).toMatchObject({ value: 2 });
    expect(report.scope_totals).toMatchObject({
      coordination_root: { regular_files: { value: 1 } },
      registered_external_roots: { regular_files: { value: 1 } },
    });
    expect(output.formats).toEqual(["json"]);
    expect(output.errors).toEqual([]);
  });

  test("renders table rows and emits versioned health JSON", async () => {
    const root = fixture();
    mkdirSync(join(root, ".harnery"));
    writeFileSync(join(root, ".harnery", "config.jsonc"), "{}");
    const table = captureEmit();
    await createHarneryProgram({ emit: table.emit, context: { repoRoot: root } }).parseAsync(
      ["storage", "inventory", "--class", "managed-artifact"],
      { from: "user" },
    );
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.every((row) => row.class === "managed-artifact")).toBeTrue();

    const health = captureEmit();
    await createHarneryProgram({ emit: health.emit, context: { repoRoot: root } }).parseAsync(
      ["storage", "health", "--json"],
      { from: "user" },
    );
    expect(health.data[0]).toMatchObject({
      schema: "harnery.storage-health/v1",
      inventory_schema: "harnery.storage-inventory/v1",
      status: "unknown",
    });
  });

  test("rejects unknown family and class filters with stable codes", async () => {
    const output = captureEmit();
    const program = createHarneryProgram({ emit: output.emit, context: { repoRoot: fixture() } });
    await program.parseAsync(["storage", "inventory", "--family", "missing"], { from: "user" });
    await program.parseAsync(["storage", "inventory", "--class", "mystery"], { from: "user" });
    expect(output.errors).toEqual([
      { code: "unknown_storage_family", message: "unknown storage family: missing" },
      { code: "unknown_storage_class", message: "unknown storage class: mystery" },
    ]);
    expect(output.exitCodes).toEqual([1, 1]);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-storage-command-"));
  roots.push(root);
  return root;
}

function hostFamily(): HarneryStorageFamily {
  const source = harneryStorageFamilies().find(({ id }) => id === "work-item-history")!;
  return {
    ...source,
    id: "host-history",
    owner: "fixture host",
    roots: (context) => [
      {
        path: join(context.coord_root, ".host", "history"),
        kind: "directory",
        match: "subtree",
        ownership: "host",
      },
    ],
    provider: {
      ...source.provider,
      provider_id: "host-history-provider",
      inventory: "filesystem",
    },
  };
}

function captureEmit(): {
  emit: EmitContext;
  data: unknown[];
  rows: Record<string, unknown>[][];
  text: string[];
  formats: (string | undefined)[];
  errors: unknown[];
  exitCodes: number[];
} {
  const data: unknown[] = [];
  const rows: Record<string, unknown>[][] = [];
  const text: string[] = [];
  const formats: (string | undefined)[] = [];
  const errors: unknown[] = [];
  const exitCodes: number[] = [];
  return {
    emit: {
      config: ({ format }) => formats.push(format),
      data: (value) => data.push(value),
      rows: (value) => rows.push(value),
      text: (value) => text.push(value),
      file: () => {},
      error: (value) => errors.push(value),
      log: () => {},
      setExitCode: (value) => exitCodes.push(value),
    },
    data,
    rows,
    text,
    formats,
    errors,
    exitCodes,
  };
}
