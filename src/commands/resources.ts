import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { formatResourceStatus, readResourceStatus } from "../core/resources/status.ts";

export function registerResourcesCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const resources = program
    .command("resources")
    .description("Observe local CPU, memory, disk capacity, and resource pressure");

  resources
    .command("status")
    .description("Read the supervisor's cached resource measurements without sampling")
    .option("--root <path>", "Explicit coordination root")
    .option("--json", "Bounded structured output")
    .option("--processes", "Include up to 20 processes, largest memory first")
    .action((options: { root?: string; json?: boolean; processes?: boolean }) => {
      const status = readResourceStatus(resolve(options.root ?? coordRoot(context)), {
        includeProcesses: options.processes,
      });
      if (options.json) {
        emit.config({ format: "json" });
        emit.data(status);
      } else {
        emit.config({ format: "text" });
        emit.text(formatResourceStatus(status, program.name()));
      }
    });

  resources
    .command("snapshot")
    .description("Capture one machine and process-resource snapshot")
    .option("--root <path>", "Explicit coordination root")
    .action(async (options: { root?: string }) => {
      try {
        const { sampleResources } = await import("../core/resources/sampler.ts");
        emit.data(sampleResources(resolve(options.root ?? coordRoot(context))).snapshot);
      } catch (error) {
        fail(emit, "resource_snapshot_failed", error);
      }
    });
}

function coordRoot(context?: HarneryProgramContext): string {
  return context?.resolveCoordRoot?.() ?? context?.repoRoot ?? process.cwd();
}

function fail(emit: EmitContext, code: string, error: unknown): void {
  emit.error({
    code,
    message: error instanceof Error ? error.message : String(error),
  });
  emit.setExitCode(1);
}
