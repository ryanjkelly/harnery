import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { monorepoRoot } from "../core/agents/index.ts";
import {
  applyTurnRollback,
  beginTurnRollback,
  inspectTurnRollback,
  prepareTurnRollback,
  sealTurnRollback,
  type TurnRollbackPlan,
} from "../core/turn-rollback/index.ts";
import { readJsonRecord } from "../core/workflow/durable-record.ts";
import { readWorkspaceBinding } from "../core/workflow/workspaces/state.ts";

/** Explicit turn boundaries; hooks cannot infer provider ownership or path scope. */
export function registerTurnRollbackCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const command = program
    .command("turn-rollback")
    .description("Capture and review exact-path content rollback in an owned workspace");
  type Options = {
    binding: string;
    turn?: string;
    generation?: string;
    path?: string[];
    yes?: boolean;
    actor?: string;
    reason?: string;
    plan?: string;
  };
  const run =
    (operation: (coordRoot: string, options: Options) => unknown | Promise<unknown>) =>
    async (options: Options) => {
      try {
        const coordRoot = context?.resolveCoordRoot?.() ?? context?.repoRoot ?? monorepoRoot();
        if (!coordRoot) throw new Error("project coordination root is unavailable");
        emit.config({ format: "json" });
        const result = await operation(coordRoot, options);
        emit.data(result);
        if (
          result &&
          typeof result === "object" &&
          "status" in result &&
          result.status === "unknown"
        )
          emit.setExitCode(1);
      } catch (error) {
        emit.error({ code: "turn_rollback_refused", message: String(error) });
        emit.setExitCode(1);
      }
    };
  const binding = (root: string, options: Options) => {
    const value = readWorkspaceBinding(root, "local-git-worktree", options.binding);
    if (!value) throw new Error("immutable workspace binding was not found");
    return value;
  };
  command
    .command("begin")
    .description("Capture exact literal paths before a turn")
    .requiredOption("--binding <id>", "Owned workspace binding ID")
    .requiredOption("--turn <id>", "Caller turn identity")
    .requiredOption("--generation <number>", "Increasing turn generation")
    .requiredOption("--path <file...>", "Exact relative file paths, including planned new files")
    .action(
      run((root, options) =>
        beginTurnRollback(root, {
          binding: binding(root, options),
          turn: { turn_id: options.turn!, generation: Number(options.generation) },
          paths: options.path!,
        }),
      ),
    );
  for (const operation of ["seal", "prepare", "show"] as const) {
    command
      .command(`${operation} <capture-id>`)
      .description(`${operation} an exact turn capture`)
      .requiredOption("--binding <id>", "Owned workspace binding ID")
      .action((id: string, options: Options) =>
        run((root, opts) => {
          const input = { binding: binding(root, opts), capture_id: id };
          return operation === "seal"
            ? sealTurnRollback(root, input)
            : operation === "prepare"
              ? prepareTurnRollback(root, input)
              : inspectTurnRollback(root, input);
        })(options),
      );
  }
  command
    .command("apply")
    .description("Preview a saved proposal, or apply it after exact confirmation")
    .requiredOption("--binding <id>", "Owned workspace binding ID")
    .requiredOption("--plan <file>", "Saved JSON proposal returned by prepare")
    .option("--yes", "Apply this exact proposal; preview is the default")
    .option("--actor <name>", "Who authorized the restore")
    .option("--reason <text>", "Why this turn is being restored")
    .action(
      run((root, options) =>
        applyTurnRollback(root, {
          binding: binding(root, options),
          plan: readJsonRecord<TurnRollbackPlan>(options.plan!, "rollback proposal"),
          yes: options.yes,
          actor: options.actor,
          reason: options.reason,
        }),
      ),
    );
}
