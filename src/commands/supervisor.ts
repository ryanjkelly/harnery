import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  requestSupervisorStop,
  runSupervisor,
  spawnSupervisor,
} from "../core/supervisor/service.ts";
import { readSupervisorStatus } from "../core/supervisor/status.ts";
import {
  readSupervisorFindings,
  readSupervisorHistory,
  readSupervisorLogFeed,
  readSupervisorSnapshot,
} from "../core/supervisor/storage.ts";

export function registerSupervisorCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const supervisor = program
    .command("supervisor")
    .description("Run Harnery's optional local diagnostic supervisor");

  supervisor
    .command("start")
    .description("Start the detached local supervisor")
    .option("--root <path>", "Explicit coordination root")
    .option("--interval-ms <milliseconds>", "Collection interval from 500 to 60000 ms", integer)
    .option(
      "--idle-exit-ms <milliseconds>",
      "Exit after this long without a live dashboard consumer or attributed agent",
      integer,
    )
    .option("--keep-alive", "Remain resident until explicitly stopped")
    .action(
      async (options: {
        root?: string;
        intervalMs?: number;
        idleExitMs?: number;
        keepAlive?: boolean;
      }) => {
        try {
          emit.data(
            await spawnSupervisor(resolve(options.root ?? coordRoot(context)), {
              intervalMs: options.intervalMs,
              idleExitMs: options.idleExitMs,
              keepAlive: options.keepAlive,
            }),
          );
        } catch (error) {
          fail(emit, "supervisor_start_failed", error);
        }
      },
    );

  supervisor
    .command("status")
    .description("Show supervisor liveness and its latest bounded projections")
    .option("--root <path>", "Explicit coordination root")
    .action((options: { root?: string }) => {
      try {
        const root = resolve(options.root ?? coordRoot(context));
        emit.data({
          service: readSupervisorStatus(root),
          snapshot: readSupervisorSnapshot(root),
          history: readSupervisorHistory(root),
          findings: readSupervisorFindings(root),
          log_feed: readSupervisorLogFeed(root),
        });
      } catch (error) {
        fail(emit, "supervisor_status_failed", error);
      }
    });

  supervisor
    .command("stop")
    .description("Request a graceful supervisor stop")
    .option("--root <path>", "Explicit coordination root")
    .action(async (options: { root?: string }) => {
      try {
        const root = resolve(options.root ?? coordRoot(context));
        let status = requestSupervisorStop(root);
        const deadline = Date.now() + 5_000;
        while (status.running && Date.now() < deadline) {
          await new Promise((done) => setTimeout(done, 50));
          status = readSupervisorStatus(root);
        }
        emit.data(status);
      } catch (error) {
        fail(emit, "supervisor_stop_failed", error);
      }
    });

  supervisor
    .command("daemon", { hidden: true })
    .description("Internal detached local supervisor entrypoint")
    .option("--root <path>", "Explicit coordination root")
    .option("--interval-ms <milliseconds>", "Collection interval", integer)
    .option("--idle-exit-ms <milliseconds>", "Idle exit interval", integer)
    .option("--keep-alive", "Remain resident until explicitly stopped")
    .action(
      async (options: {
        root?: string;
        intervalMs?: number;
        idleExitMs?: number;
        keepAlive?: boolean;
      }) => {
        try {
          emit.data(
            await runSupervisor({
              coordRoot: resolve(options.root ?? coordRoot(context)),
              intervalMs: options.intervalMs,
              idleExitMs: options.idleExitMs,
              keepAlive: options.keepAlive,
            }),
          );
        } catch (error) {
          fail(emit, "supervisor_daemon_failed", error);
        }
      },
    );
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
  emit.error({ code, message: error instanceof Error ? error.message : String(error) });
  emit.setExitCode(1);
}
