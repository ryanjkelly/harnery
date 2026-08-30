import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext, loadLazyCommand } from "../commander.ts";
import { harneryStorageFamilies } from "../core/storage/builtins.ts";
import type {
  HarneryStorageFamily,
  HarneryStorageInventoryReport,
} from "../core/storage/contract.ts";
import type { HarneryMaintenanceProvider } from "../core/storage/maintenance.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage command", () => {
  test("is registered with inventory and health subcommands", async () => {
    const program = createHarneryProgram();
    await loadLazyCommand(program, "storage");
    const storage = program.commands.find((command) => command.name() === "storage");
    expect(storage).toBeDefined();
    expect(storage?.commands.map((command) => command.name()).sort()).toEqual([
      "health",
      "inventory",
      "maintain",
      "status",
    ]);
    expect(
      storage?.commands.find((command) => command.name() === "maintain")?.helpInformation(),
    ).toContain("--authorize-structured-log-deletion");
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
    expect(report.schema).toBe("harnery.storage-inventory/v2");
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
      schema: "harnery.storage-health/v2",
      inventory_schema: "harnery.storage-inventory/v2",
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

  test("plans and executes only an exact confirmed maintenance transaction", async () => {
    const root = fixture();
    mkdirSync(join(root, ".host", "maintained"), { recursive: true });
    writeFileSync(join(root, ".host", "maintained", "one.jsonl"), "one\n");
    let applied = 0;
    const output = captureEmit();
    const program = createHarneryProgram({
      emit: output.emit,
      context: {
        repoRoot: root,
        storage: { families: [maintainedHostFamily()] },
        storageMaintenanceProviders: [maintenanceProvider(() => (applied += 1))],
      },
    });
    await program.parseAsync(["storage", "maintain", "--family", "host-maintained", "--json"], {
      from: "user",
    });
    const planned = output.data[0] as { transaction_id: string; state: string; actions: unknown[] };
    expect(planned).toMatchObject({ state: "planned" });
    expect(planned.actions).toHaveLength(1);
    await program.parseAsync(
      ["storage", "maintain", "--transaction", planned.transaction_id, "--yes", "--json"],
      { from: "user" },
    );
    expect(output.data[1]).toMatchObject({ state: "committed" });
    expect(applied).toBe(1);

    const status = captureEmit();
    await createHarneryProgram({ emit: status.emit, context: { repoRoot: root } }).parseAsync(
      ["storage", "status", "--transaction", planned.transaction_id, "--json"],
      { from: "user" },
    );
    expect(status.data[0]).toMatchObject([{ transaction_id: planned.transaction_id }]);
  });

  test("structured-log authorization does not authorize another destructive provider", async () => {
    const root = fixture();
    mkdirSync(join(root, ".host", "maintained"), { recursive: true });
    writeFileSync(join(root, ".host", "maintained", "one.jsonl"), "one\n");
    let applied = 0;
    const output = captureEmit();
    const program = createHarneryProgram({
      emit: output.emit,
      context: {
        repoRoot: root,
        storage: { families: [maintainedHostFamily()] },
        storageMaintenanceProviders: [
          destructiveMaintenanceProvider("host-owned-deletion", () => (applied += 1)),
        ],
      },
    });
    await program.parseAsync(["storage", "maintain", "--family", "host-maintained", "--json"], {
      from: "user",
    });
    const planned = output.data[0] as { transaction_id: string; actions: unknown[] };
    expect(planned.actions).toHaveLength(1);
    await program.parseAsync(
      [
        "storage",
        "maintain",
        "--transaction",
        planned.transaction_id,
        "--yes",
        "--authorize-structured-log-deletion",
        "--json",
      ],
      { from: "user" },
    );
    expect(output.errors.at(-1)).toEqual({
      code: "destructive_activation_required",
      message:
        "structured-log deletion requires its provider scope, exact transaction, --yes, and explicit authorization",
    });
    expect(applied).toBe(0);
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

function maintainedHostFamily(): HarneryStorageFamily {
  const source = harneryStorageFamilies().find(({ id }) => id === "storage-maintenance-run-log")!;
  return {
    ...source,
    id: "host-maintained",
    owner: "fixture host",
    roots: (context) => [
      {
        path: join(context.coord_root, ".host", "maintained"),
        kind: "directory",
        match: "subtree",
        ownership: "host",
      },
    ],
    policy: {
      ...source.policy,
      policy_version: "host-maintained-v1",
      retention: { ...source.policy.retention, status: "active" },
    },
    provider: {
      ...source.provider,
      provider_id: "host-maintained-provider",
      maintenance: "storage",
    },
  };
}

function maintenanceProvider(onApply: () => void): HarneryMaintenanceProvider {
  return {
    family_id: "host-maintained",
    plan: () => ({
      actions: [
        {
          action_id: "compact-one",
          family_id: "host-maintained",
          kind: "compact",
          target_ref: "one",
          files: 1,
          bytes: 4,
          destructive: false,
        },
      ],
    }),
    apply: () => {
      onApply();
      return { outcome: "applied" };
    },
  };
}

function destructiveMaintenanceProvider(
  scope: string,
  onApply: () => void,
): HarneryMaintenanceProvider {
  return {
    family_id: "host-maintained",
    destructive_scope: scope,
    plan: () => ({
      actions: [
        {
          action_id: "delete-one",
          family_id: "host-maintained",
          kind: "delete",
          target_ref: "one",
          files: 1,
          bytes: 4,
          destructive: true,
          authorization_scope: scope,
        },
      ],
    }),
    apply: () => {
      onApply();
      return { outcome: "applied" };
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
