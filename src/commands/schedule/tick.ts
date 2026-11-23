/**
 * `schedule tick`: the scheduler's single entry point. The installed timer
 * calls it with `--source timer`, session activity with `--source activity`,
 * and a person with no flag.
 */

import { resolve } from "node:path";
import type { Command } from "commander";
import { defaultEmit, type EmitContext } from "../../commander.ts";
import { resolveCoordRoot } from "../../core/agents/coord-client.ts";
import type { ScheduleTickSource } from "../../core/schedule/heartbeat.ts";
import { runScheduleTick, type ScheduleTickOptions } from "../../core/schedule/tick.ts";

const SOURCES: readonly ScheduleTickSource[] = ["timer", "activity", "manual"];

export interface ScheduleTickCommandDeps {
  /** Test seam: overrides fields of the tick options. */
  tickOptions?: Partial<Omit<ScheduleTickOptions, "coordRoot" | "source">>;
}

/**
 * Attach `tick` to the `schedule` command. Output goes through `emit` (the
 * host's output pipeline); exit code 0 for `ok`, `busy` and a scheduled
 * run's child, 1 for `error`.
 */
export function registerScheduleTickCommands(
  schedule: Command,
  emit: EmitContext = defaultEmit,
  deps: ScheduleTickCommandDeps = {},
): void {
  schedule
    .command("tick")
    .description(
      "Run every enrolled job that is due on this machine, once, and write the heartbeat",
    )
    .option("--source <source>", "What called the tick: timer, activity or manual", "manual")
    .option("--root <dir>", "Coordination root (defaults to the current checkout)")
    .action(async (opts: { source: string; root?: string }) => {
      if (!SOURCES.includes(opts.source as ScheduleTickSource)) {
        emit.error({
          code: "invalid_source",
          message: `--source must be one of ${SOURCES.join(", ")}; got "${opts.source}"`,
        });
        emit.setExitCode(2);
        return;
      }
      const root = resolve(opts.root ?? resolveCoordRoot() ?? process.cwd());
      const result = await runScheduleTick({
        ...deps.tickOptions,
        coordRoot: root,
        source: opts.source as ScheduleTickSource,
      });
      emit.config({ format: "json" });
      emit.data(result);
      emit.setExitCode(result.status === "error" ? 1 : 0);
    });
}
