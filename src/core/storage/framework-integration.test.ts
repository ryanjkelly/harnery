import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProviderConversation, readConversationArchive } from "../conversations/archive.ts";
import { buildConversationContextPack } from "../conversations/context-pack.ts";
import type {
  HarneryConversationProvider,
  HarneryConversationQueryRequest,
  HarneryNativeConversationRecord,
} from "../conversations/contract.ts";
import { queryConversationRecords } from "../conversations/query.ts";
import type { EventV3SupportInventoryEntry } from "../events/v3/support-storage/inventory.ts";
import {
  activateEventV3SupportReplacement,
  authorizeEventV3SupportReplacement,
  planEventV3SupportReplacement,
  planEventV3SupportTransaction,
  recoverEventV3SupportTransaction,
  verifyEventV3SupportTransactionShadow,
  writeEventV3SupportTransactionShadow,
} from "../events/v3/support-storage/maintenance.ts";
import type { HarneryInboxLimits } from "../inbox/contract.ts";
import { HarneryInboxService } from "../inbox/service.ts";
import { createStorageCatalog } from "./catalog.ts";
import { appendDurableHistoryRecord, streamDurableHistory } from "./durable-history.ts";
import { encodeLogRecord, type HarneryLogRecordV1 } from "./jsonl.ts";
import {
  executeStorageMaintenance,
  HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
  type HarneryMaintenanceAction,
  type HarneryMaintenanceProvider,
  planStorageMaintenance,
  runAutomaticMaintenanceSlice,
  writePressureSummary,
} from "./maintenance.ts";
import { createStructuredLogMaintenanceProviders } from "./maintenance-providers.ts";
import { queryLogs, readLogFollow } from "./query.ts";
import { FileSegmentSink, readSegmentManifest } from "./segments.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("storage framework end-to-end canary", () => {
  test("writes, rotates, and queries operational logs through the catalog", async () => {
    const root = fixture("logs");
    const family = createStorageCatalog({ coord_root: root }).require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append([logRecord(family, 1, "canary.started")]);
    await sink.append([logRecord(family, 2, "canary.completed")]);
    expect(readSegmentManifest(directory, family).segments).toHaveLength(1);
    const result = await queryLogs([family], { max_records: 10, max_bytes: 100_000 });
    expect(result.records.map(({ event }) => event)).toEqual([
      "canary.started",
      "canary.completed",
    ]);
  });

  test("plans and executes one exact structured-log retention transaction", async () => {
    const root = fixture("log-retention");
    const catalog = createStorageCatalog({ coord_root: root, project_root: root });
    const family = catalog.require("agent-hook-debug-log");
    const directory = join(root, ".harnery", "logs", "agent-hook-debug");
    const sink = new FileSegmentSink({ directory, family, max_segment_bytes: 1 });
    await sink.append(
      [logRecord(family, 1, "retention.expired")],
      {},
      false,
      new Date("2026-08-01T00:00:00.000Z"),
    );
    await sink.append(
      [logRecord(family, 2, "retention.current")],
      {},
      false,
      new Date("2026-08-02T00:00:00.000Z"),
    );
    const providers = createStructuredLogMaintenanceProviders(catalog);
    const pressure = {
      schema: HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
      captured_at: "2026-08-29T12:00:00.000Z",
      families: [
        {
          family_id: family.id,
          logical_bytes: 1_000_000,
          regular_files: 10,
          needs_maintenance: true,
          observed_at: "2026-08-29T12:00:00.000Z",
        },
      ],
    } as const;
    const refused = await planStorageMaintenance(catalog, providers, pressure, {
      persist: true,
      now: new Date("2026-08-29T12:00:00.000Z"),
    });
    await expect(
      executeStorageMaintenance(catalog, providers, refused.transaction_id, { yes: false }),
    ).rejects.toThrow("exact transaction id and --yes");
    await expect(
      executeStorageMaintenance(catalog, providers, refused.transaction_id, { yes: true }),
    ).rejects.toThrow("explicit authorization");

    const planned = await planStorageMaintenance(catalog, providers, pressure, {
      persist: true,
      now: new Date("2026-08-29T12:01:00.000Z"),
    });
    expect(planned.actions.some(({ kind }) => kind === "prune-log-segment")).toBeTrue();
    const committed = await executeStorageMaintenance(catalog, providers, planned.transaction_id, {
      yes: true,
      authorize_structured_log_deletion: true,
    });
    expect(committed.state).toBe("committed");
    const query = await queryLogs([family], { max_records: 10, max_bytes: 100_000 });
    expect(query.records.map(({ event }) => event)).toEqual(["retention.current"]);
    expect(query.expired_through).toEqual({ [family.id]: 1 });
    expect(
      (
        await readLogFollow(
          family,
          { family_id: family.id, manifest_sequence: 0, active_offset: 0 },
          100_000,
        )
      ).history_expired,
    ).toBeTrue();
  });

  test("rotates crash-safe durable history and replays every record in order", async () => {
    const objectDir = join(fixture("history"), ".harnery", "work", "canary");
    const options = { max_record_bytes: 128, max_segment_bytes: 128 };
    appendDurableHistoryRecord(objectDir, { sequence: 1, payload: "x".repeat(60) }, options);
    expect(
      appendDurableHistoryRecord(objectDir, { sequence: 2, payload: "y".repeat(60) }, options)
        .rotated,
    ).toBeTrue();
    const replay: Array<{ sequence: number }> = [];
    for await (const record of streamDurableHistory<{ sequence: number }>(objectDir, {
      max_record_bytes: 1_024,
      max_records: 10,
    })) {
      replay.push(record);
    }
    expect(replay.map(({ sequence }) => sequence)).toEqual([1, 2]);
  });

  test("keeps inbox messages private and repeats them after a surfacing crash", async () => {
    const root = fixture("inbox");
    const service = new HarneryInboxService({
      coord_root: root,
      limits: inboxLimits(),
      id: () => "message-one",
      now: () => new Date("2026-08-29T12:00:00.000Z"),
    });
    service.send({
      sender_instance_id: "sender",
      sender_display_name: "Sender",
      recipient_instance_id: "recipient",
      recipient_display_name: "Recipient",
      body: "private fixture message",
    });
    await expect(
      service.surface("recipient", () => {
        throw new Error("surface crash");
      }),
    ).rejects.toThrow("surface crash");
    expect(service.pending("recipient")).toHaveLength(1);
    const observed: string[] = [];
    const result = await service.surface("recipient", (records) => {
      observed.push(...records.map(({ body }) => body));
    });
    expect(observed).toEqual(["private fixture message"]);
    expect(result.repeated_after_crash_possible).toBeTrue();
  });

  test("archives, queries, and packages conversation history as untrusted context", async () => {
    const root = fixture("conversation");
    const provider = conversationProvider();
    const captured = await captureProviderConversation(provider, {
      coord_root: root,
      project_scope_id: "project-a",
      conversation_id: "conversation-a",
      access_mode: "archive",
      authority_mode: "shadow",
      now: () => new Date("2026-08-29T12:01:00.000Z"),
    });
    expect(captured).toMatchObject({ state: "captured", accepted: 2 });
    const records = readConversationArchive(root, "fixture", "conversation-a");
    const snapshot = await provider.snapshot("project-a", "conversation-a");
    const query = queryConversationRecords(records, [snapshot], conversationQuery());
    expect(query.hits[0]?.citation.native_record_id).toBe("assistant-1");
    expect(
      buildConversationContextPack(query, { max_tokens: 100, max_bytes: 1_000 }),
    ).toMatchObject({
      boundary: "untrusted-historical-data",
      automatic_injection: false,
      truncated: false,
    });
  });

  test("packs V3 support only through shadow proof and keeps replacement disabled", async () => {
    const fixture = v3Fixture();
    const planned = await planEventV3SupportTransaction(fixture.input);
    await expect(
      recoverEventV3SupportTransaction({
        transaction_root: fixture.transactions,
        transaction_id: planned.transaction_id,
        expected_current_genesis_id: "gen_wrong",
      }),
    ).rejects.toThrow("event_v3_support_transaction_genesis_mismatch");
    const shadow = await writeEventV3SupportTransactionShadow({
      transaction_root: fixture.transactions,
      transaction_id: planned.transaction_id,
      minimum_harnery_version: "0.36.0",
      now: "2026-08-29T00:01:00.000Z",
    });
    expect(shadow.state).toBe("shadow-written");
    const verified = await verifyEventV3SupportTransactionShadow({
      transaction_root: fixture.transactions,
      transaction_id: planned.transaction_id,
      expected_current_genesis_id: "gen_fixture",
      now: "2026-08-29T00:02:00.000Z",
    });
    expect(verified.state).toBe("shadow-verified");
    await expect(
      authorizeEventV3SupportReplacement({
        transaction_root: fixture.transactions,
        transaction_id: planned.transaction_id,
        exact_transaction_id: `vst_${"f".repeat(32)}`,
        yes: true,
        now: "2026-08-29T00:03:00.000Z",
      }),
    ).rejects.toThrow("event_v3_support_replacement_exact_transaction_mismatch");
    await expect(
      authorizeEventV3SupportReplacement({
        transaction_root: fixture.transactions,
        transaction_id: planned.transaction_id,
        exact_transaction_id: planned.transaction_id,
        yes: false,
        now: "2026-08-29T00:03:00.000Z",
      }),
    ).rejects.toThrow("event_v3_support_replacement_yes_required");
    await authorizeEventV3SupportReplacement({
      transaction_root: fixture.transactions,
      transaction_id: planned.transaction_id,
      exact_transaction_id: planned.transaction_id,
      yes: true,
      now: "2026-08-29T00:03:00.000Z",
    });
    expect(
      await planEventV3SupportReplacement({
        transaction_root: fixture.transactions,
        transaction_id: planned.transaction_id,
      }),
    ).toMatchObject({ enabled: false });
    expect(() => activateEventV3SupportReplacement()).toThrow(
      "event_v3_support_replacement_activation_disabled",
    );
    expect(readFileSync(fixture.source, "utf8")).toBe('{"code":"safe"}\n');
  });

  test("requires exact maintenance confirmation and never runs destructive automatic work", async () => {
    const root = fixture("maintenance");
    const catalog = createStorageCatalog({ coord_root: root, project_root: root });
    let applied = 0;
    const safeProvider = maintenanceProvider(false, () => {
      applied += 1;
    });
    const planned = await planStorageMaintenance(catalog, [safeProvider], maintenancePressure(), {
      persist: true,
      now: new Date("2026-08-29T12:00:00.000Z"),
    });
    expect(planned).toMatchObject({ dry_run: true, state: "planned" });
    await expect(
      executeStorageMaintenance(catalog, [safeProvider], planned.transaction_id, { yes: false }),
    ).rejects.toThrow("requires the exact transaction id and --yes");
    await expect(
      executeStorageMaintenance(catalog, [safeProvider], "wrong-transaction", { yes: true }),
    ).rejects.toThrow();
    expect(
      await executeStorageMaintenance(catalog, [safeProvider], planned.transaction_id, {
        yes: true,
      }),
    ).toMatchObject({ state: "committed", dry_run: false });
    expect(applied).toBe(1);

    const automaticRoot = fixture("automatic");
    const automaticCatalog = createStorageCatalog({
      coord_root: automaticRoot,
      project_root: automaticRoot,
    });
    writePressureSummary(automaticRoot, maintenancePressure());
    let destructiveApplied = false;
    const destructive = maintenanceProvider(true, () => {
      destructiveApplied = true;
    });
    await expect(
      runAutomaticMaintenanceSlice(automaticCatalog, [destructive], {
        now: new Date("2026-08-29T12:00:00.000Z"),
        execute: true,
      }),
    ).rejects.toThrow("explicit authorization");
    expect(destructiveApplied).toBeFalse();
  });
});

function fixture(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `harnery-framework-${label}-`));
  roots.push(root);
  return root;
}

function logRecord(
  family: ReturnType<typeof createStorageCatalog>["families"][number],
  sequence: number,
  event: string,
): Buffer {
  const record: HarneryLogRecordV1 = {
    schema: "harnery.log-record/v1",
    kind: "record",
    emitted_at: new Date(sequence * 1_000).toISOString(),
    family_id: family.id,
    policy_version: family.policy.policy_version,
    component_id: "framework-canary",
    level: "info",
    event,
    writer_id: "framework-canary",
    writer_seq: sequence,
    context: {},
    fields: {},
  };
  return encodeLogRecord(record, family);
}

function inboxLimits(): HarneryInboxLimits {
  return {
    max_message_body_bytes: 256,
    max_pending_count: 10,
    max_pending_bytes: 1_024,
    max_history_bytes: 16_384,
    max_history_records: 100,
    warning_pressure_ratio: 0.8,
    max_surface_count: 4,
    max_surface_bytes: 512,
    max_surface_tokens: 128,
    surfaced_grace_ms: 1_000,
    terminal_grace_ms: 5_000,
  };
}

function conversationProvider(): HarneryConversationProvider {
  return {
    capabilities: {
      provider_id: "fixture",
      roles: ["user", "assistant"],
      can_list: true,
      can_stream_source: true,
      can_replay_archive: true,
      default_completeness: "complete",
      default_omissions: [],
      retention_behavior: "fixture retained",
    },
    async list(projectScopeId) {
      return [
        {
          provider_id: "fixture",
          project_scope_id: projectScopeId,
          conversation_id: "conversation-a",
          snapshot_id: "snapshot-a",
          completeness: "complete",
          omissions: [],
        },
      ];
    },
    async snapshot(projectScopeId, conversationId) {
      return {
        snapshot_id: "snapshot-a",
        provider_id: "fixture",
        project_scope_id: projectScopeId,
        conversation_id: conversationId,
        observed_at: "2026-08-29T12:00:00.000Z",
        completeness: "complete",
        omissions: [],
      };
    },
    async *stream() {
      yield* conversationRecords();
    },
  };
}

function conversationRecords(): HarneryNativeConversationRecord[] {
  return [
    {
      native_conversation_id: "native-a",
      native_record_id: "user-1",
      native_sequence: 1,
      role: "user",
      occurred_at: "2026-08-29T12:00:00.000Z",
      content: "What is the requirement?",
    },
    {
      native_conversation_id: "native-a",
      native_record_id: "assistant-1",
      native_sequence: 2,
      role: "assistant",
      occurred_at: "2026-08-29T12:00:01.000Z",
      content: "The requirement is a bounded integration canary.",
    },
  ];
}

function conversationQuery(): HarneryConversationQueryRequest {
  return {
    project_scope_id: "project-a",
    conversation_id: "conversation-a",
    text: "bounded integration",
    limit: 10,
    context_before: 1,
    budgets: {
      max_source_records: 100,
      max_decoded_bytes: 10_000,
      max_matches: 10,
      max_wall_ms: 1_000,
      max_regex_chars: 100,
    },
  };
}

function v3Fixture(): {
  source: string;
  transactions: string;
  input: Parameters<typeof planEventV3SupportTransaction>[0];
} {
  const root = fixture("v3");
  const authority = join(root, "authority");
  const transactions = join(root, "transactions");
  mkdirSync(join(authority, "diagnostics"), { recursive: true });
  mkdirSync(transactions, { recursive: true });
  const source = join(authority, "diagnostics", "safe.json");
  const contents = Buffer.from('{"code":"safe"}\n');
  writeFileSync(source, contents, { mode: 0o600 });
  const entry: EventV3SupportInventoryEntry = {
    authority: { state: "active", genesis_id: "gen_fixture" },
    family: "diagnostic",
    relative_path: "diagnostics/safe.json",
    bytes: contents.length,
    digest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    disposition: "pack-eligible",
    reasons: ["diagnostic_consumer_window_elapsed"],
    observed: {
      recorded_at: "2026-08-20T00:00:00.000Z",
      modified_at: "2026-08-20T00:00:00.000Z",
    },
  };
  return {
    source,
    transactions,
    input: {
      transaction_root: transactions,
      authority_root: authority,
      root_id: "root_fixture",
      genesis_id: "gen_fixture",
      authority_state: "active",
      entries: [entry],
      catalog_version: "storage-v1",
      policy_version: "event-v3-support-v1",
      now: "2026-08-29T00:00:00.000Z",
    },
  };
}

function maintenanceAction(destructive: boolean): HarneryMaintenanceAction {
  return {
    action_id: destructive ? "delete-canary" : "safe-canary",
    family_id: "storage-maintenance-run-log",
    kind: destructive ? "delete" : "compact",
    target_ref: "fixture",
    files: 1,
    bytes: 10,
    destructive,
    ...(destructive ? { authorization_scope: "fixture-owner-delete" } : {}),
  };
}

function maintenanceProvider(destructive: boolean, apply: () => void): HarneryMaintenanceProvider {
  return {
    family_id: "storage-maintenance-run-log",
    ...(destructive ? { destructive_scope: "fixture-owner-delete" } : {}),
    plan: () => ({ actions: [maintenanceAction(destructive)] }),
    apply: () => {
      apply();
      return { outcome: "applied" };
    },
  };
}

function maintenancePressure() {
  return {
    schema: HARNERY_MAINTENANCE_PRESSURE_SCHEMA,
    captured_at: "2026-08-29T12:00:00.000Z",
    families: [
      {
        family_id: "storage-maintenance-run-log",
        logical_bytes: 1_000,
        regular_files: 10,
        needs_maintenance: true,
        observed_at: "2026-08-29T12:00:00.000Z",
      },
    ],
  } as const;
}
