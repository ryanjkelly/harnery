/**
 * Synthetic signal scripts for commands that run outside an open turn (d).
 *
 * Each script is an ordered list of hook and command signals for one native
 * session. A test drives them through its own recorder inputs, so the script
 * stays independent of how a test builds its ledger.
 */
import type { CommandObservationV3 } from "../producers/command.ts";

export type CommandSignalV3 = "command.started" | "command.output_observed" | "command.completed";

export type CommandTurnStepV3 =
  | {
      kind: "hook";
      signal: "session-start" | "user-prompt-submit" | "stop";
      turn_id?: string;
    }
  | { kind: "command"; signal: CommandSignalV3; native_command_id: string };

export const COMMAND_TURN_SESSION_ID = "native-session";

/** A command a session-start hook runs before the first prompt opens a turn. */
export const COMMAND_WITHOUT_TURN_V3: readonly CommandTurnStepV3[] = [
  { kind: "hook", signal: "session-start" },
  { kind: "command", signal: "command.started", native_command_id: "cmd-before-turn" },
  { kind: "command", signal: "command.output_observed", native_command_id: "cmd-before-turn" },
  { kind: "command", signal: "command.completed", native_command_id: "cmd-before-turn" },
];

/** A command started inside one turn whose completion lands after that turn ends and the next starts. */
export const COMMAND_ACROSS_TURNS_V3: readonly CommandTurnStepV3[] = [
  { kind: "hook", signal: "session-start" },
  { kind: "hook", signal: "user-prompt-submit", turn_id: "turn-first" },
  { kind: "command", signal: "command.started", native_command_id: "cmd-across-turns" },
  { kind: "hook", signal: "stop", turn_id: "turn-first" },
  { kind: "hook", signal: "user-prompt-submit", turn_id: "turn-second" },
  { kind: "command", signal: "command.completed", native_command_id: "cmd-across-turns" },
];

/** The recorder observation for one command step, with synthetic content. */
export function commandObservationV3(
  step: Extract<CommandTurnStepV3, { kind: "command" }>,
): CommandObservationV3 {
  const id = step.native_command_id;
  if (step.signal === "command.started") {
    return {
      native_command_id: id,
      argv: ["toolkit", "status"],
      intent: "check status",
      executable: "toolkit",
      intent_kind: "research",
      sensitive_argument_count: 0,
    };
  }
  if (step.signal === "command.output_observed") {
    return {
      native_command_id: id,
      native_observation_id: `${id}:output:1`,
      stream: "stdout",
      output: "status ok",
      output_lines: 1,
    };
  }
  return { native_command_id: id, exit_code: 0, duration_ms: 25 };
}
