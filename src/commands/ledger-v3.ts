import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  initializeEventLedgerV3,
  readEventV3ControlState,
  sha256V3,
} from "../core/events/v3/index.ts";

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

function emitFailure(emit: EmitContext, code: string, error: unknown): never {
  emit.error({ code, message: error instanceof Error ? error.message : String(error) });
  throw error;
}
