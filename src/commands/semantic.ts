import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  createSemanticAdapters,
  discoverSemanticReaders,
  inspectSemanticDocument,
  readSemanticManifest,
  readSemanticServiceStatus,
  readSemanticSoakReport,
  requestSemanticServiceStop,
  runSemanticOnce,
  runSemanticServiceDaemon,
  semanticPaths,
  spawnSemanticService,
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

  const service = semantic
    .command("service")
    .description("Run semantic reading as a singleton service");

  service
    .command("start")
    .description("Start or resume the detached per-root semantic reader service")
    .option("--root <path>", "Explicit coordination root")
    .option("--calls-per-hour <count>", "Configured call ceiling below the hard limit", integer)
    .action(async (options: { root?: string; callsPerHour?: number }) => {
      try {
        emit.data(
          await spawnSemanticService(resolve(options.root ?? coordRoot(context)), {
            callsPerHour: options.callsPerHour,
          }),
        );
      } catch (error) {
        emitFailure(emit, "semantic_service_start_failed", error);
      }
    });

  service
    .command("status")
    .description("Show reader liveness, rolling calls, token usage, routes, and pending work")
    .option("--root <path>", "Explicit coordination root")
    .action((options: { root?: string }) => {
      try {
        emit.data(readSemanticServiceStatus(resolve(options.root ?? coordRoot(context))));
      } catch (error) {
        emitFailure(emit, "semantic_service_status_failed", error);
      }
    });

  service
    .command("stop")
    .description("Request a graceful stop after the current model call")
    .option("--root <path>", "Explicit coordination root")
    .action(async (options: { root?: string }) => {
      try {
        const root = resolve(options.root ?? coordRoot(context));
        let status = requestSemanticServiceStop(root);
        const deadline = Date.now() + 5_000;
        while (status.running && Date.now() < deadline) {
          await new Promise((done) => setTimeout(done, 50));
          status = readSemanticServiceStatus(root);
        }
        emit.data(status);
      } catch (error) {
        emitFailure(emit, "semantic_service_stop_failed", error);
      }
    });

  service
    .command("daemon", { hidden: true })
    .description("Internal detached semantic service entrypoint")
    .option("--root <path>", "Explicit coordination root")
    .option("--calls-per-hour <count>", "Configured call ceiling below the hard limit", integer)
    .action(async (options: { root?: string; callsPerHour?: number }) => {
      try {
        emit.data(
          await runSemanticServiceDaemon({
            coordRoot: resolve(options.root ?? coordRoot(context)),
            callsPerHour: options.callsPerHour,
          }),
        );
      } catch (error) {
        emitFailure(emit, "semantic_service_daemon_failed", error);
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
    .command("soak")
    .description("Summarize recent reader outcomes, controlled cues, stability, and token usage")
    .option("--root <path>", "Explicit coordination root")
    .option("--minutes <count>", "Lookback window in whole minutes", integer)
    .action((options: { root?: string; minutes?: number }) => {
      try {
        emit.data(
          readSemanticSoakReport(resolve(options.root ?? coordRoot(context)), {
            ...(options.minutes !== undefined ? { minutes: options.minutes } : {}),
          }),
        );
      } catch (error) {
        emitFailure(emit, "semantic_soak_failed", error);
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
