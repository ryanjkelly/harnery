import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  readResourceServiceStatus,
  readResourceSnapshot,
  requestResourceServiceStop,
  runResourceService,
  sampleResources,
  spawnResourceService,
} from "../core/resources/index.ts";

export function registerResourcesCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const resources = program
    .command("resources")
    .description("Observe local CPU and memory pressure by agent and process tree");

  resources
    .command("snapshot")
    .description("Capture one machine and process-resource snapshot")
    .option("--root <path>", "Explicit coordination root")
    .action((options: { root?: string }) => {
      try {
        emit.data(sampleResources(resolve(options.root ?? coordRoot(context))).snapshot);
      } catch (error) {
        fail(emit, "resource_snapshot_failed", error);
      }
    });

  const service = resources
    .command("service")
    .description("Run the local resource observer as a singleton service");

  service
    .command("start")
    .description("Start the detached resource observer")
    .option("--root <path>", "Explicit coordination root")
    .option("--interval-ms <milliseconds>", "Sampling interval from 500 to 60000 ms", integer)
    .action(async (options: { root?: string; intervalMs?: number }) => {
      try {
        emit.data(
          await spawnResourceService(resolve(options.root ?? coordRoot(context)), {
            intervalMs: options.intervalMs,
          }),
        );
      } catch (error) {
        fail(emit, "resource_service_start_failed", error);
      }
    });

  service
    .command("status")
    .description("Show observer liveness, freshness, and latest snapshot")
    .option("--root <path>", "Explicit coordination root")
    .action((options: { root?: string }) => {
      try {
        const root = resolve(options.root ?? coordRoot(context));
        emit.data({
          service: readResourceServiceStatus(root),
          snapshot: readResourceSnapshot(root),
        });
      } catch (error) {
        fail(emit, "resource_service_status_failed", error);
      }
    });

  service
    .command("stop")
    .description("Request a graceful observer stop")
    .option("--root <path>", "Explicit coordination root")
    .action(async (options: { root?: string }) => {
      try {
        const root = resolve(options.root ?? coordRoot(context));
        let status = requestResourceServiceStop(root);
        const deadline = Date.now() + 5_000;
        while (status.running && Date.now() < deadline) {
          await new Promise((done) => setTimeout(done, 50));
          status = readResourceServiceStatus(root);
        }
        emit.data(status);
      } catch (error) {
        fail(emit, "resource_service_stop_failed", error);
      }
    });

  service
    .command("daemon", { hidden: true })
    .description("Internal detached resource observer entrypoint")
    .option("--root <path>", "Explicit coordination root")
    .option("--interval-ms <milliseconds>", "Sampling interval", integer)
    .action(async (options: { root?: string; intervalMs?: number }) => {
      try {
        emit.data(
          await runResourceService({
            coordRoot: resolve(options.root ?? coordRoot(context)),
            intervalMs: options.intervalMs,
          }),
        );
      } catch (error) {
        fail(emit, "resource_service_daemon_failed", error);
      }
    });
}

function coordRoot(context?: HarneryProgramContext): string {
  return context?.resolveCoordRoot?.() ?? context?.repoRoot ?? process.cwd();
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`expected an integer, got ${value}`);
  return parsed;
}

function fail(emit: EmitContext, code: string, error: unknown): void {
  emit.error({
    code,
    message: error instanceof Error ? error.message : String(error),
  });
  emit.setExitCode(1);
}
