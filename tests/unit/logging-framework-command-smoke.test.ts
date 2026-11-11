import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHarneryProgram, type EmitContext, loadLazyCommand } from "../../src/commander.ts";
import { removeDir } from "../helpers/remove-dir.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

describe("logging framework command smoke", () => {
  test("public read and dry-run surfaces stay bounded and fail closed", async () => {
    const readRoot = fixture("reads");
    const v3Fixture = join(readRoot, ".harnery", "ledgers", "v3", "fixture.jsonl");
    mkdirSync(join(readRoot, ".harnery", "ledgers", "v3"), { recursive: true });
    writeFileSync(join(readRoot, ".harnery", "config.jsonc"), "{}\n");
    writeFileSync(v3Fixture, '{"event_type":"fixture"}\n');
    const beforeReads = filesystemSnapshot(readRoot);
    const capture = createCapture();
    const dependencies = commandDependencies(readRoot, capture);

    for (const argv of [
      ["storage", "inventory", "--json"],
      ["storage", "health", "--json"],
      ["logs", "list", "--json"],
      ["logs", "query", "--max-records", "8", "--max-bytes", "4096", "--json"],
    ]) {
      expect(await invoke(dependencies, argv), argv.join(" ")).toBe(0);
    }
    capture.help.push(await renderHelp(dependencies, ["ledger-v3", "verify-support"]));
    capture.help.push(await renderHelp(dependencies, ["ledger-v3", "support-plan"]));
    capture.help.push(await renderHelp(dependencies, ["storage", "maintain"]));

    expect(filesystemSnapshot(readRoot)).toEqual(beforeReads);
    expect(capture.data).toContainEqual(
      expect.objectContaining({ schema: "harnery.storage-inventory/v2" }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({ schema: "harnery.storage-health/v2" }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({
        schema: "harnery.logs-list/v2",
        diagnostics: expect.any(Array),
        dormant_families: expect.any(Array),
        families: expect.arrayContaining([
          expect.objectContaining({
            effective_policy: expect.objectContaining({
              max_bytes: expect.any(Number),
              max_age_ms: expect.any(Number),
              fingerprint: expect.any(String),
              provenance: expect.any(Object),
            }),
            usage: expect.objectContaining({
              managed_bytes: expect.any(Number),
              unmanaged_bytes: expect.any(Number),
            }),
            pressure: expect.objectContaining({
              state: expect.any(String),
              reason_codes: expect.any(Array),
            }),
            retention: expect.objectContaining({
              state: expect.any(String),
              enforcement: expect.any(String),
              reason_codes: expect.any(Array),
            }),
          }),
        ]),
      }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({ schema: "harnery.logs-query/v1", records: [] }),
    );
    expect(capture.help.join("\n")).toContain("Validate one V3 support-pack manifest");
    expect(capture.help.join("\n")).toContain("Inventory explicit V3 support evidence");
    expect(capture.help.join("\n")).toContain("--authorize-structured-log-deletion");

    const missingAuthorityExit = await invoke(dependencies, [
      "ledger-v3",
      "recover",
      "--root",
      readRoot,
      "--approval-record-id",
      "approval-fixture",
      "--yes",
    ]);
    expect(missingAuthorityExit).toBe(1);
    expect(capture.errors.at(-1)).toEqual({
      code: "ledger_v3_recovery_failed",
      message: "event_v3_recovery_not_required:closed",
    });
    expect(filesystemSnapshot(readRoot)).toEqual(beforeReads);

    const maintenanceRoot = fixture("maintenance");
    const maintenanceCapture = createCapture();
    const maintenance = commandDependencies(maintenanceRoot, maintenanceCapture);
    expect(await invoke(maintenance, ["storage", "maintain", "--budget", "50ms", "--json"])).toBe(
      0,
    );
    const plan = maintenanceCapture.data.at(-1) as {
      transaction_id: string;
      state: string;
      dry_run: boolean;
      actions: unknown[];
    };
    expect(plan).toMatchObject({ state: "planned", dry_run: true, actions: [] });
    expect(
      await invoke(maintenance, [
        "storage",
        "maintain",
        "--transaction",
        plan.transaction_id,
        "--json",
      ]),
    ).toBe(1);
    expect(maintenanceCapture.errors.at(-1)).toEqual({
      code: "confirmation_required",
      message: "maintenance execution requires the exact transaction id and --yes",
    });
  }, 15_000);
});

interface CommandDependencies {
  root: string;
  capture: Capture;
}

function commandDependencies(root: string, capture: Capture): CommandDependencies {
  return {
    root,
    capture,
  };
}

async function invoke(dependencies: CommandDependencies, argv: string[]): Promise<number> {
  const { capture } = dependencies;
  const exitsBefore = capture.exitCodes.length;
  const program = createHarneryProgram({
    emit: capture.emit,
    context: {
      repoRoot: dependencies.root,
      resolveCoordRoot: () => dependencies.root,
    },
  });
  program.configureOutput({
    writeOut: (value) => capture.help.push(value),
    writeErr: (value) => capture.help.push(value),
  });
  program.exitOverride();
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if ((error as { code?: string }).code === "commander.helpDisplayed") return 0;
    return 1;
  }
  return capture.exitCodes.length > exitsBefore ? (capture.exitCodes.at(-1) ?? 1) : 0;
}

async function renderHelp(dependencies: CommandDependencies, path: string[]): Promise<string> {
  let command = createProgram(dependencies);
  await loadLazyCommand(command, path[0] ?? "");
  for (const name of path) {
    const child = command.commands.find((candidate) => candidate.name() === name);
    if (!child) throw new Error(`missing command help surface: ${path.join(" ")}`);
    command = child;
  }
  return command.helpInformation();
}

function createProgram(dependencies: CommandDependencies) {
  return createHarneryProgram({
    emit: dependencies.capture.emit,
    context: {
      repoRoot: dependencies.root,
      resolveCoordRoot: () => dependencies.root,
    },
  });
}

interface Capture {
  readonly emit: EmitContext;
  readonly data: unknown[];
  readonly errors: unknown[];
  readonly exitCodes: number[];
  readonly help: string[];
}

function createCapture(): Capture {
  const data: unknown[] = [];
  const errors: unknown[] = [];
  const exitCodes: number[] = [];
  const help: string[] = [];
  const emit: EmitContext = {
    config() {},
    data: (value) => data.push(value),
    rows() {},
    text() {},
    file() {},
    error: (value) => errors.push(value),
    log() {},
    setExitCode: (value) => exitCodes.push(value),
  };
  return { emit, data, errors, exitCodes, help };
}

function fixture(suffix: string): string {
  const root = mkdtempSync(join(tmpdir(), `harnery-command-smoke-${suffix}-`));
  roots.push(root);
  return root;
}

function filesystemSnapshot(root: string): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      paths.push(relative(root, path));
      if (entry.isDirectory()) visit(path);
    }
  };
  visit(root);
  return paths.sort();
}
