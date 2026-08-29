import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  inventoryLegacyV1Segments,
  streamLegacyV1Rows,
  verifyLegacyV1HardFence,
  writeLegacyV1Canary,
} from "../core/events/legacy-storage/index.ts";
import {
  initializeEventLedgerV3,
  readEventV3ControlState,
  recoverInvalidEventLedgerV3,
  sha256V3,
} from "../core/events/v3/index.ts";
import {
  authorizeEventV3SupportReplacement,
  planEventV3SupportReplacement,
  readEventV3SupportPackManifest,
  readEventV3SupportTransaction,
  streamEventV3SupportPackRecords,
  unpackEventV3SupportPack,
  verifyEventV3SupportTransactionShadow,
  writeEventV3SupportTransactionShadow,
} from "../core/events/v3/support-storage/index.ts";

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

function emitFailure(emit: EmitContext, code: string, error: unknown): never {
  emit.error({ code, message: error instanceof Error ? error.message : String(error) });
  throw error;
}
