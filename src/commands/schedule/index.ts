/**
 * `schedule`: one list of every schedule this machine can see, and the
 * opt-in scheduler that runs the project's own jobs. Each part attaches its
 * subcommands to the parent command built here.
 */

import type { Command } from "commander";
import type { EmitContext } from "../../commander.ts";
import { registerScheduleJobsCommands } from "./jobs.ts";
import { registerScheduleListCommands } from "./list.ts";
import { registerScheduleTickCommands } from "./tick.ts";
import { registerScheduleTimerCommands } from "./timer.ts";

export function registerScheduleCommand(program: Command, emit: EmitContext): void {
  const schedule = program
    .command("schedule")
    .description("List every schedule on this machine and run the project's scheduled jobs");
  registerScheduleListCommands(schedule, emit);
  registerScheduleJobsCommands(schedule, { emit });
  registerScheduleTickCommands(schedule, emit);
  registerScheduleTimerCommands(schedule, emit);
}
