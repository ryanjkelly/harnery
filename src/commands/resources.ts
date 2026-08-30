import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { sampleResources } from "../core/resources/index.ts";

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
