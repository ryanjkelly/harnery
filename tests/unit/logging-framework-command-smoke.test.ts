import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHarneryProgram, type EmitContext } from "../../src/commander.ts";
import { HarneryConversationCatalog } from "../../src/core/conversations/catalog.ts";
import type { HarneryConversationProvider } from "../../src/core/conversations/contract.ts";
import type { HarneryInboxLimits } from "../../src/core/inbox/contract.ts";
import { HarneryInboxService, inboxPath } from "../../src/core/inbox/service.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
    const privateBody = "private-inbox-canary-6e67a0";

    for (const argv of [
      ["storage", "inventory", "--json"],
      ["storage", "health", "--json"],
      ["logs", "list", "--json"],
      ["logs", "query", "--max-records", "8", "--max-bytes", "4096", "--json"],
      ["inbox", "list", "recipient", "--json"],
      [
        "messages",
        "--from",
        "sender",
        "--from-name",
        "Sender",
        "--to",
        "recipient",
        "--to-name",
        "Recipient",
        "--body",
        privateBody,
        "--json",
      ],
      ["conversations", "list", "--json"],
      ["conversations", "query", "--text", "fixture", "--json"],
      ["conversations", "context", "--record", "native-record", "--json"],
    ]) {
      expect(await invoke(dependencies, argv), argv.join(" ")).toBe(0);
    }
    capture.help.push(renderHelp(dependencies, ["ledger-v3", "verify-support"]));
    capture.help.push(renderHelp(dependencies, ["ledger-v3", "support-plan"]));

    expect(filesystemSnapshot(readRoot)).toEqual(beforeReads);
    expect(existsSync(inboxPath(readRoot, "recipient"))).toBeFalse();
    expect(capture.data).toContainEqual(
      expect.objectContaining({ schema: "harnery.storage-inventory/v1" }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({ schema: "harnery.storage-health/v1" }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({ schema: "harnery.logs-list/v1" }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({ schema: "harnery.logs-query/v1", records: [] }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({ schema: "harnery.inbox-list/v1", rows: [] }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({
        schema: "harnery.message-send/v1",
        state: "dry-run",
        writes: false,
      }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({ schema: "harnery.conversation-list/v1" }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({ schema: "harnery.conversation-query/v1", scanned_records: 1 }),
    );
    expect(capture.data).toContainEqual(
      expect.objectContaining({
        schema: "harnery.conversation-context-pack/v1",
        boundary: "untrusted-historical-data",
        automatic_injection: false,
      }),
    );
    expect(capture.help.join("\n")).toContain("Validate one V3 support-pack manifest");
    expect(capture.help.join("\n")).toContain("Inventory explicit V3 support evidence");
    expect(readFilesBelow(join(readRoot, ".harnery", "ledgers", "v3"))).not.toContain(privateBody);

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
  inbox: HarneryInboxService;
  conversations: HarneryConversationCatalog;
}

function commandDependencies(root: string, capture: Capture): CommandDependencies {
  return {
    root,
    capture,
    inbox: new HarneryInboxService({
      coord_root: root,
      limits: inboxLimits(),
      now: () => new Date("2026-08-29T12:00:00.000Z"),
      id: () => "fixture",
    }),
    conversations: new HarneryConversationCatalog([conversationProvider()]),
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
      coordinationInbox: dependencies.inbox,
      conversations: {
        catalog: dependencies.conversations,
        projectScopeId: "fixture-project",
      },
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

function renderHelp(dependencies: CommandDependencies, path: string[]): string {
  let command = createProgram(dependencies);
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
      coordinationInbox: dependencies.inbox,
      conversations: {
        catalog: dependencies.conversations,
        projectScopeId: "fixture-project",
      },
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

function conversationProvider(): HarneryConversationProvider {
  return {
    capabilities: {
      provider_id: "fixture-provider",
      roles: ["user", "assistant"],
      can_list: true,
      can_stream_source: true,
      can_replay_archive: true,
      default_completeness: "complete",
      default_omissions: [],
      retention_behavior: "fixture",
    },
    async list(projectScopeId) {
      return [
        {
          provider_id: "fixture-provider",
          project_scope_id: projectScopeId,
          conversation_id: "fixture-conversation",
          snapshot_id: "fixture-snapshot",
          completeness: "complete",
          omissions: [],
        },
      ];
    },
    async snapshot(projectScopeId, conversationId) {
      return {
        snapshot_id: "fixture-snapshot",
        provider_id: "fixture-provider",
        project_scope_id: projectScopeId,
        conversation_id: conversationId,
        observed_at: "2026-08-29T12:00:00.000Z",
        completeness: "complete",
        omissions: [],
      };
    },
    async *stream() {
      yield {
        native_conversation_id: "fixture-native-conversation",
        native_record_id: "native-record",
        native_sequence: 1,
        role: "assistant",
        occurred_at: "2026-08-29T11:00:00.000Z",
        content: "fixture conversation evidence",
      };
    },
  };
}

function inboxLimits(): HarneryInboxLimits {
  return {
    max_message_body_bytes: 256,
    max_pending_count: 8,
    max_pending_bytes: 2_048,
    max_history_bytes: 16_384,
    max_history_records: 64,
    warning_pressure_ratio: 0.8,
    max_surface_count: 4,
    max_surface_bytes: 512,
    max_surface_tokens: 128,
    surfaced_grace_ms: 1_000,
    terminal_grace_ms: 5_000,
  };
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

function readFilesBelow(root: string): string {
  if (!existsSync(root)) return "";
  let content = "";
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) content += readFileSync(path, "utf8");
    }
  };
  visit(root);
  return content;
}
