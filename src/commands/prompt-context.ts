import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  consumeCursorPromptContext,
  PROMPT_CONTEXT_SESSION_KEY_ENV,
} from "../core/hooks/prompt-context/state.ts";

const CONSUME_SCHEMA = "harnery.prompt-context-consume/v1" as const;

/** Register the explicit Cursor compatibility path for prompt-time context. */
export function registerPromptContextCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const root = program
    .command("prompt-context")
    .description("Consume host-provided context staged for the current prompt");

  root
    .command("consume")
    .description(
      "Atomically read this Cursor session's pending prompt context. Empty state exits successfully.",
    )
    .option("--json", "Emit the stable consume envelope")
    .action((options: { json?: boolean }) => {
      try {
        const sessionKey = process.env[PROMPT_CONTEXT_SESSION_KEY_ENV];
        if (!sessionKey) {
          throw new Error(`${PROMPT_CONTEXT_SESSION_KEY_ENV} is not set for this Cursor session`);
        }
        const result = consumeCursorPromptContext({
          coordRoot: resolveCoordRoot(context),
          sessionKey,
        });
        if (result.status === "invalid_key") {
          throw new Error(`${PROMPT_CONTEXT_SESSION_KEY_ENV} is not a valid session key`);
        }
        if (options.json) {
          emit.config({ format: "json" });
          emit.data({
            schema: CONSUME_SCHEMA,
            status: result.status === "consumed" ? "consumed" : "empty",
            ...(result.status === "consumed"
              ? {
                  context: result.context,
                  conversation_fingerprint: result.conversationFingerprint,
                  turn_fingerprint: result.turnFingerprint,
                }
              : {}),
          });
        } else if (result.status === "consumed") {
          emit.text(result.context);
        }
      } catch (error) {
        emit.error({
          code: "prompt_context_consume_failed",
          message: error instanceof Error ? error.message : String(error),
        });
        emit.setExitCode(1);
      }
    });
}

function resolveCoordRoot(context?: HarneryProgramContext): string {
  return resolve(
    context?.resolveCoordRoot?.() ??
      context?.repoRoot ??
      process.env.HARNERY_COORD_ROOT ??
      process.cwd(),
  );
}
