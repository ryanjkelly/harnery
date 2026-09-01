import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  compressSealedLegacyV1Segments,
  inventoryLegacyV1Segments,
  streamLegacyV1Rows,
  verifyLegacyV1HardFence,
  writeLegacyV1Canary,
} from "../core/events/legacy-storage/index.ts";
import {
  cleanEventV3Archives,
  initializeEventLedgerV3,
  inventoryEventV3Archives,
  readEventV3ControlState,
  recoverInvalidEventLedgerV3,
  sha256V3,
} from "../core/events/v3/index.ts";
import type { EventV3SupportClassificationEvidence } from "../core/events/v3/support-storage/index.ts";
import {
  authorizeEventV3SupportReplacement,
  inventoryEventV3Support,
  planEventV3SupportReplacement,
  planEventV3SupportTransaction,
  readEventV3SupportPackManifest,
  readEventV3SupportTransaction,
  streamEventV3SupportPackRecords,
  unpackEventV3SupportPack,
  verifyEventV3SupportTransactionShadow,
  writeEventV3SupportTransactionShadow,
} from "../core/events/v3/support-storage/index.ts";

type SupportEvidence = Record<
  string,
  Omit<
    EventV3SupportClassificationEvidence,
    "family" | "authority_state" | "now" | "file_regular" | "file_owner_only"
  >
>;

/** Inspect or initialize the universal V3 event ledger. */
export function registerLedgerV3Command(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const command = program
    .command("ledger-v3")
    .description("Inspect or initialize the universal event-ledger V3 epoch");

  command
    .command("status")
    .description("Read the V3 control boundary without changing it")
    .action(() => {
      try {
        emit.data(readEventV3ControlState(coordRoot(context)));
      } catch (error) {
        emitFailure(emit, "ledger_v3_status_failed", error);
      }
    });

  const archives = command
    .command("archives")
    .description("Inventory and enforce bounded retention for complete closed V3 epochs");

  archives
    .command("list")
    .description("Show closed epochs, retention classifications, and planned actions")
    .option("--root <path>", "Explicit coordination root")
    .action((options: { root?: string }) => {
      try {
        const rows = inventoryEventV3Archives(resolve(options.root ?? coordRoot(context)));
        emit.data({ rows, meta: summarizeArchiveRows(rows) });
      } catch (error) {
        emitFailure(emit, "ledger_v3_archive_inventory_failed", error);
      }
    });

  archives
    .command("clean")
    .description("Preview closed-epoch deletion; pass --yes to execute the exact current plan")
    .option("--root <path>", "Explicit coordination root")
    .option("--yes", "Delete only epochs still classified expired or over-budget")
    .action((options: { root?: string; yes?: boolean }) => {
      try {
        const rows = cleanEventV3Archives(resolve(options.root ?? coordRoot(context)), {
          yes: options.yes,
        });
        emit.data({ rows, meta: summarizeArchiveRows(rows) });
      } catch (error) {
        emitFailure(emit, "ledger_v3_archive_cleanup_failed", error);
      }
    });

  command
    .command("initialize")
    .description("Create V3 control state, or archive and replace the current V3 epoch")
    .option("--root <path>", "Explicit coordination root")
    .requiredOption("--approval-record-id <id>", "Durable approval record identifier")
    .option("--force-new-epoch", "Archive the current V3 epoch and create a new one")
    .action((options: { root?: string; approvalRecordId: string; forceNewEpoch?: boolean }) => {
      try {
        const root = resolve(options.root ?? coordRoot(context));
        emit.data(
          initializeEventLedgerV3({
            coordRoot: root,
            harneryBuild: repositoryBuild(resolve(import.meta.dir, "..", "..")),
            hostBuild: repositoryBuild(root),
            configDigest: configDigest(root),
            approvalRecordId: options.approvalRecordId,
            forceNewEpoch: options.forceNewEpoch === true,
          }),
        );
      } catch (error) {
        emitFailure(emit, "ledger_v3_initialize_failed", error);
      }
    });

  command
    .command("recover")
    .description("Quarantine one invalid active authority and start a clean V3 epoch")
    .option("--root <path>", "Explicit coordination root")
    .requiredOption("--approval-record-id <id>", "Durable approval record identifier")
    .option("--yes", "Confirm the failed authority should be quarantined")
    .action((options: { root?: string; approvalRecordId: string; yes?: boolean }) => {
      try {
        if (!options.yes) throw new Error("--yes is required to recover an invalid V3 authority");
        const root = resolve(options.root ?? coordRoot(context));
        emit.data(
          recoverInvalidEventLedgerV3({
            coordRoot: root,
            harneryBuild: repositoryBuild(resolve(import.meta.dir, "..", "..")),
            hostBuild: repositoryBuild(root),
            configDigest: configDigest(root),
            approvalRecordId: options.approvalRecordId,
          }),
        );
      } catch (error) {
        emitFailure(emit, "ledger_v3_recovery_failed", error);
      }
    });

  command
    .command("verify-support")
    .description("Validate one V3 support-pack manifest and every packed source digest")
    .argument("<manifest>", "Support-pack manifest path")
    .action(async (manifest: string) => {
      try {
        const path = resolve(manifest);
        const supportManifest = await readEventV3SupportPackManifest(path);
        let entries = 0;
        for await (const _record of streamEventV3SupportPackRecords(path)) entries += 1;
        emit.data({
          valid: true,
          pack_id: supportManifest.pack_id,
          entries,
          source_files_digest: supportManifest.authority.source_files_digest,
        });
      } catch (error) {
        emitFailure(emit, "ledger_v3_support_verify_failed", error);
      }
    });

  command
    .command("unpack-support")
    .description("Unpack one verified support pack into a new explicit destination")
    .argument("<manifest>", "Support-pack manifest path")
    .requiredOption("--out <directory>", "New destination; existing paths are refused")
    .action(async (manifest: string, options: { out: string }) => {
      try {
        emit.data(await unpackEventV3SupportPack(resolve(manifest), resolve(options.out)));
      } catch (error) {
        emitFailure(emit, "ledger_v3_support_unpack_failed", error);
      }
    });

  command
    .command("support-transaction-status")
    .description("Read one exact V3 support maintenance transaction")
    .requiredOption("--transaction <id>", "Exact support maintenance transaction")
    .option("--root <path>", "Explicit coordination root")
    .action(async (options: { transaction: string; root?: string }) => {
      try {
        const root = resolve(options.root ?? coordRoot(context));
        emit.data(await readEventV3SupportTransaction(transactionRoot(root), options.transaction));
      } catch (error) {
        emitFailure(emit, "ledger_v3_support_transaction_status_failed", error);
      }
    });

  command
    .command("support-plan")
    .description("Inventory explicit V3 support evidence and persist a shadow-only transaction")
    .requiredOption("--authority-root <directory>", "Exact active or archived authority root")
    .requiredOption("--authority-state <state>", "Authority state: active or archived")
    .requiredOption("--root-id <id>", "Authority root identifier")
    .requiredOption("--genesis-id <id>", "Authority genesis binding")
    .requiredOption("--evidence <json>", "JSON evidence map keyed by every support relative path")
    .requiredOption("--observed-at <timestamp>", "Explicit ISO-8601 inventory time")
    .requiredOption("--catalog-version <version>", "Storage catalog version used for the plan")
    .requiredOption("--policy-version <version>", "Support classification policy version")
    .option("--source-authority-digest <digest>", "Required archived authority digest")
    .option("--root <path>", "Explicit coordination root for transaction persistence")
    .action(
      async (options: {
        authorityRoot: string;
        authorityState: string;
        rootId: string;
        genesisId: string;
        evidence: string;
        observedAt: string;
        catalogVersion: string;
        policyVersion: string;
        sourceAuthorityDigest?: string;
        root?: string;
      }) => {
        try {
          const state = supportAuthorityState(options.authorityState);
          const observedAt = exactIsoTimestamp(options.observedAt);
          const evidence = readSupportEvidence(resolve(options.evidence));
          const entries = await inventoryEventV3Support({
            authority_root: resolve(options.authorityRoot),
            authority: {
              state,
              genesis_id: nonemptyOption(options.genesisId, "genesis-id"),
            },
            now: observedAt,
            evidence,
          });
          if (
            !sameSortedStrings(
              Object.keys(evidence),
              entries.map((entry) => entry.relative_path),
            )
          ) {
            throw new Error("event_v3_support_plan_evidence_paths_mismatch");
          }
          if (entries.some((entry) => entry.disposition !== "pack-eligible")) {
            throw new Error("event_v3_support_transaction_contains_ineligible_source");
          }
          const rootId = nonemptyOption(options.rootId, "root-id");
          const genesisId = nonemptyOption(options.genesisId, "genesis-id");
          const catalogVersion = nonemptyOption(options.catalogVersion, "catalog-version");
          const policyVersion = nonemptyOption(options.policyVersion, "policy-version");
          const authorityDigest = options.sourceAuthorityDigest
            ? exactSha256(options.sourceAuthorityDigest)
            : undefined;
          if (state === "archived" && !authorityDigest) {
            throw new Error("event_v3_support_transaction_archive_digest_required");
          }
          if (state === "active" && authorityDigest) {
            throw new Error("event_v3_support_transaction_active_digest_forbidden");
          }
          const root = resolve(options.root ?? coordRoot(context));
          const transactions = transactionRoot(root);
          mkdirSync(transactions, { recursive: true, mode: 0o700 });
          emit.data(
            await planEventV3SupportTransaction({
              transaction_root: transactions,
              authority_root: resolve(options.authorityRoot),
              root_id: rootId,
              genesis_id: genesisId,
              authority_state: state,
              ...(authorityDigest ? { source_authority_digest: authorityDigest } : {}),
              entries,
              catalog_version: catalogVersion,
              policy_version: policyVersion,
              now: observedAt,
            }),
          );
        } catch (error) {
          emitFailure(emit, "ledger_v3_support_plan_failed", error);
        }
      },
    );

  command
    .command("support-shadow")
    .description("Write and verify a shadow pack while preserving every loose source")
    .requiredOption("--transaction <id>", "Exact support maintenance transaction")
    .requiredOption("--genesis-id <id>", "Current authority genesis binding")
    .requiredOption("--minimum-harnery-version <version>", "Minimum pack-aware Harnery version")
    .option("--root <path>", "Explicit coordination root")
    .action(
      async (options: {
        transaction: string;
        genesisId: string;
        minimumHarneryVersion: string;
        root?: string;
      }) => {
        try {
          const root = resolve(options.root ?? coordRoot(context));
          const transactions = transactionRoot(root);
          let current = await readEventV3SupportTransaction(transactions, options.transaction);
          if (current.authority.genesis_id !== options.genesisId) {
            throw new Error("event_v3_support_transaction_genesis_mismatch");
          }
          if (current.state === "planned") {
            current = await writeEventV3SupportTransactionShadow({
              transaction_root: transactions,
              transaction_id: current.transaction_id,
              minimum_harnery_version: options.minimumHarneryVersion,
              now: new Date().toISOString(),
            });
          }
          if (current.state === "shadow-written") {
            current = await verifyEventV3SupportTransactionShadow({
              transaction_root: transactions,
              transaction_id: current.transaction_id,
              expected_current_genesis_id: options.genesisId,
              now: new Date().toISOString(),
            });
          }
          if (current.state !== "shadow-verified") {
            throw new Error(`support shadow cannot resume from ${current.state}`);
          }
          emit.data({
            transaction_id: current.transaction_id,
            state: current.state,
            sources_preserved: true,
            replacement_enabled: false,
          });
        } catch (error) {
          emitFailure(emit, "ledger_v3_support_shadow_failed", error);
        }
      },
    );

  command
    .command("support-replacement")
    .description("Authorize an exact verified canary plan; source replacement remains disabled")
    .requiredOption("--transaction <id>", "Transaction to inspect")
    .requiredOption("--exact-transaction <id>", "Repeat the exact transaction identifier")
    .option("--yes", "Record exact replacement authorization")
    .option("--root <path>", "Explicit coordination root")
    .action(
      async (options: {
        transaction: string;
        exactTransaction: string;
        yes?: boolean;
        root?: string;
      }) => {
        try {
          const root = resolve(options.root ?? coordRoot(context));
          const transactions = transactionRoot(root);
          const authorized = await authorizeEventV3SupportReplacement({
            transaction_root: transactions,
            transaction_id: options.transaction,
            exact_transaction_id: options.exactTransaction,
            yes: options.yes === true,
            now: new Date().toISOString(),
          });
          emit.data(
            await planEventV3SupportReplacement({
              transaction_root: transactions,
              transaction_id: authorized.transaction_id,
            }),
          );
        } catch (error) {
          emitFailure(emit, "ledger_v3_support_replacement_failed", error);
        }
      },
    );

  command
    .command("verify-v1-fence")
    .description("Verify the sealed legacy V1 hard fence and terminal digest")
    .option("--root <path>", "Explicit coordination root")
    .action(async (options: { root?: string }) => {
      try {
        emit.data(await verifyLegacyV1HardFence(resolve(options.root ?? coordRoot(context))));
      } catch (error) {
        emitFailure(emit, "ledger_v1_fence_verify_failed", error);
      }
    });

  command
    .command("legacy-inventory")
    .description("List sealed root events*.ndjson* history after the V1 fence passes")
    .option("--root <path>", "Explicit coordination root")
    .action(async (options: { root?: string }) => {
      try {
        const root = resolve(options.root ?? coordRoot(context));
        await verifyLegacyV1HardFence(root);
        emit.data(await inventoryLegacyV1Segments(root));
      } catch (error) {
        emitFailure(emit, "ledger_v1_inventory_failed", error);
      }
    });

  command
    .command("legacy-compress")
    .description("Preview verified gzip replacement of sealed non-terminal V1 shards")
    .option("--root <path>", "Explicit coordination root")
    .option("--yes", "Replace only unchanged shards after exact logical-row parity")
    .action(async (options: { root?: string; yes?: boolean }) => {
      try {
        const rows = await compressSealedLegacyV1Segments(
          resolve(options.root ?? coordRoot(context)),
          { yes: options.yes },
        );
        emit.data({
          rows,
          meta: {
            total: rows.length,
            would_compress: rows.filter((row) => row.action === "would-compress").length,
            compressed: rows.filter((row) => row.action === "compressed").length,
            bytes_before: rows.reduce((sum, row) => sum + row.bytes_before, 0),
            bytes_after: rows.reduce((sum, row) => sum + (row.bytes_after ?? row.bytes_before), 0),
          },
        });
      } catch (error) {
        emitFailure(emit, "ledger_v1_compression_failed", error);
      }
    });

  command
    .command("verify-legacy")
    .description("Stream and validate one loose or manifest-bound gzip legacy segment")
    .argument("<source>", "Loose segment or compressed-segment manifest")
    .action(async (source: string) => {
      try {
        let rows = 0;
        for await (const row of streamLegacyV1Rows(resolve(source))) rows = row.row_number;
        emit.data({ valid: true, rows });
      } catch (error) {
        emitFailure(emit, "ledger_v1_segment_verify_failed", error);
      }
    });

  command
    .command("legacy-canary")
    .description("Write one shadow gzip canary while retaining the sealed loose segment")
    .requiredOption("--source-filename <name>", "Root legacy segment filename")
    .requiredOption("--out <directory>", "Shadow output directory")
    .requiredOption("--minimum-harnery-version <version>", "Minimum canary-aware version")
    .option("--shadow", "Confirm shadow-only compression")
    .option("--root <path>", "Explicit coordination root")
    .action(
      async (options: {
        sourceFilename: string;
        out: string;
        minimumHarneryVersion: string;
        shadow?: boolean;
        root?: string;
      }) => {
        try {
          if (!options.shadow) throw new Error("--shadow is required for legacy canary creation");
          emit.data(
            await writeLegacyV1Canary({
              coord_root: resolve(options.root ?? coordRoot(context)),
              source_filename: options.sourceFilename,
              output_directory: resolve(options.out),
              minimum_harnery_version: options.minimumHarneryVersion,
              created_at: new Date().toISOString(),
            }),
          );
        } catch (error) {
          emitFailure(emit, "ledger_v1_canary_failed", error);
        }
      },
    );
}

function coordRoot(context: HarneryProgramContext | undefined): string {
  return resolve(
    context?.resolveCoordRoot?.() ??
      context?.repoRoot ??
      process.env.HARNERY_COORD_ROOT ??
      process.cwd(),
  );
}

function repositoryBuild(root: string): string {
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const commit = result.status === 0 ? result.stdout.trim() : "";
  if (/^[0-9a-f]{40,64}$/.test(commit)) return commit;
  return createHash("sha256").update(resolve(root)).digest("hex");
}

function configDigest(root: string): `sha256:${string}` {
  const path = resolve(root, ".harnery", "config.jsonc");
  return sha256V3(existsSync(path) ? readFileSync(path) : Buffer.from("{}\n"));
}

function transactionRoot(root: string): string {
  return resolve(root, ".harnery", "maintenance", "transactions", "v3-support");
}

function supportAuthorityState(value: string): "active" | "archived" {
  if (value === "active" || value === "archived") return value;
  throw new Error("event_v3_support_plan_authority_state_invalid");
}

function exactIsoTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("event_v3_support_plan_timestamp_invalid");
  }
  return value;
}

function exactSha256(value: string): `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error("event_v3_support_plan_authority_digest_invalid");
  }
  return value as `sha256:${string}`;
}

function nonemptyOption(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`event_v3_support_plan_${name}_empty`);
  return value;
}

function readSupportEvidence(path: string): SupportEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("event_v3_support_plan_evidence_invalid");
  }
  if (!isRecord(parsed)) throw new Error("event_v3_support_plan_evidence_invalid");
  for (const evidence of Object.values(parsed)) {
    if (!isRecord(evidence) || !validSupportEvidence(evidence)) {
      throw new Error("event_v3_support_plan_evidence_invalid");
    }
  }
  return parsed as SupportEvidence;
}

const supportEvidenceBooleanFields = new Set([
  "recovery_bound",
  "recovery_packing_enabled",
  "epoch_maintenance_enabled",
  "active_session_tee_enabled",
  "active_committed_receipt_enabled",
  "contract_valid",
  "maintenance_owned",
  "terminal",
  "pending",
  "turn_sealed",
  "finalization_complete",
  "event_references_resolved",
  "event_references_same_epoch",
  "lease_live",
  "stale_writer_grace_elapsed",
  "ready_sibling",
  "producer_pending_reference",
  "event_row_digest_matches",
  "transaction_digest_matches",
  "receipt_grace_elapsed",
  "archive_has_ready_transaction",
]);
const supportEvidenceStringFields = new Set(["recorded_at", "filename_recorded_at"]);
const supportEvidenceNumberFields = new Set([
  "maximum_loose_consumer_window_ms",
  "fixed_consumer_grace_ms",
  "writer_tolerance_ms",
]);

function validSupportEvidence(evidence: Record<string, unknown>): boolean {
  return Object.entries(evidence).every(([key, value]) => {
    if (supportEvidenceBooleanFields.has(key)) return typeof value === "boolean";
    if (supportEvidenceStringFields.has(key)) return typeof value === "string";
    if (supportEvidenceNumberFields.has(key)) {
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    }
    return false;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameSortedStrings(left: string[], right: string[]): boolean {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}

function summarizeArchiveRows(
  rows: Array<{ classification: string; action: string; bytes: number | null }>,
): Record<string, unknown> {
  const classifications: Record<string, number> = {};
  for (const row of rows) {
    classifications[row.classification] = (classifications[row.classification] ?? 0) + 1;
  }
  return {
    total: rows.length,
    bytes: rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
    classifications,
    would_delete: rows.filter((row) => row.action === "would-delete").length,
    would_delete_bytes: rows.reduce(
      (sum, row) => sum + (row.action === "would-delete" ? (row.bytes ?? 0) : 0),
      0,
    ),
    deleted: rows.filter((row) => row.action === "deleted").length,
  };
}

function emitFailure(emit: EmitContext, code: string, error: unknown): never {
  emit.error({ code, message: error instanceof Error ? error.message : String(error) });
  throw error;
}
