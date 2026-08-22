import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  createSemanticAdapters,
  discoverSemanticReaders,
  inspectSemanticDocument,
  readSemanticManifest,
  runSemanticOnce,
  semanticPaths,
} from "../core/semantic/index.ts";

export function registerSemanticCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const semantic = program
    .command("semantic")
    .description("Build and inspect evidence-cited semantic readings of active V3 generations");

  semantic
    .command("once")
    .description("Run one bounded semantic pass using each generation's source harness")
    .option("--root <path>", "Explicit coordination root")
    .option("--calls-per-hour <count>", "Configured call ceiling below the hard limit", integer)
    .action(async (options: { root?: string; callsPerHour?: number }) => {
      try {
        emit.data(
          await runSemanticOnce({
            coordRoot: resolve(options.root ?? coordRoot(context)),
            callsPerHour: options.callsPerHour,
          }),
        );
      } catch (error) {
        emitFailure(emit, "semantic_once_failed", error);
      }
    });

  semantic
    .command("inspect")
    .description("Inspect one generation or instance semantic document")
    .argument("<instance-or-generation>")
    .option("--root <path>", "Explicit coordination root")
    .action((instanceOrGeneration: string, options: { root?: string }) => {
      try {
        const document = inspectSemanticDocument(
          resolve(options.root ?? coordRoot(context)),
          instanceOrGeneration,
        );
        if (!document) throw new Error(`no semantic document for ${instanceOrGeneration}`);
        emit.data(document);
      } catch (error) {
        emitFailure(emit, "semantic_inspect_failed", error);
      }
    });

  semantic
    .command("doctor")
    .description("Inspect semantic reader availability without making a model request")
    .option("--root <path>", "Explicit coordination root")
    .action((options: { root?: string }) => {
      try {
        const root = resolve(options.root ?? coordRoot(context));
        emit.data({
          schema_version: 1,
          root,
          storage: semanticPaths(root).root,
          readers: discoverSemanticReaders(createSemanticAdapters()),
          manifest: readManifestSafe(root),
        });
      } catch (error) {
        emitFailure(emit, "semantic_doctor_failed", error);
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

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error("count must be a positive integer");
  return parsed;
}

function readManifestSafe(root: string) {
  try {
    return readSemanticManifest(root);
  } catch {
    return undefined;
  }
}

function emitFailure(emit: EmitContext, code: string, error: unknown): never {
  emit.error({ code, message: error instanceof Error ? error.message : String(error) });
  throw error;
}
