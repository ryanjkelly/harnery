// `admission`: inspect the machine-wide admission queues, or run an arbitrary
// command while holding a slot on a named resource. The queue mechanics live
// in src/lib/admission.ts; this command owns flag parsing, human/JSON status
// rendering, and exit-code propagation for the wrapped child process.

import { spawn } from "node:child_process";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveBinName } from "../core/config.ts";
import {
  type AdmissionEntry,
  type AdmissionStatus,
  AdmissionTimeoutError,
  acquireAdmission,
  admissionStatus,
  listAdmissionResources,
} from "../lib/admission.ts";
import { admissionBaseDir } from "./qa-run.ts";

interface AdmissionStatusOpts {
  resource?: string;
  json?: boolean;
}

interface AdmissionRunOpts {
  resource: string;
  capacity?: string;
  timeout?: string;
  label?: string;
}

const LABEL_MAX_CHARS = 80;

/** Parse an integer flag with a bounded range; undefined means invalid. */
function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

function describeEntry(entry: AdmissionEntry): string {
  const since = entry.acquired_at ?? entry.created_at;
  return `${entry.label || "(no label)"} (pid ${entry.pid}) since ${since}`;
}

function logResourceStatus(emit: EmitContext, status: AdmissionStatus): void {
  emit.log(
    `${status.resource}: ${status.holders.length} holder(s), ${status.waiters.length} waiter(s)`,
    "info",
  );
  for (const holder of status.holders) emit.log(`  holding: ${describeEntry(holder)}`, "info");
  for (const waiter of status.waiters) emit.log(`  waiting: ${describeEntry(waiter)}`, "info");
}

export function registerAdmissionCommand(program: Command, emit: EmitContext): void {
  const admission = program
    .command("admission")
    .description(
      "Machine-wide admission control for heavy jobs: inspect the per-resource " +
        "slot queues, or run a command while holding a slot.",
    )
    .enablePositionalOptions();

  admission
    .command("status")
    .description(
      "Show holders and waiters per admission resource. Queues prune dead-PID, " +
        "expired, and torn entries as a side effect of being listed.",
    )
    .option("--resource <name>", "Show one resource instead of all of them.")
    .option("--json", "Emit { resources: [{ resource, holders, waiters }] } as JSON.")
    .action((opts: AdmissionStatusOpts) => {
      const dir = admissionBaseDir();
      const resources = opts.resource !== undefined ? [opts.resource] : listAdmissionResources(dir);
      const statuses = resources.map((resource) => admissionStatus({ dir, resource }));
      if (opts.json) {
        emit.data({
          resources: statuses.map((status) => ({
            resource: status.resource,
            holders: status.holders,
            waiters: status.waiters,
          })),
        });
        return;
      }
      const active = statuses.filter(
        (status) => status.holders.length > 0 || status.waiters.length > 0,
      );
      if (active.length === 0) {
        emit.log(
          opts.resource !== undefined
            ? `no admission activity on ${opts.resource}`
            : "no admission activity",
          "info",
        );
        return;
      }
      for (const status of active) logResourceStatus(emit, status);
    });

  admission
    .command("run")
    .description(
      "Acquire one slot on an admission resource, run <command...> with inherited " +
        "stdio (no shell — the first token is the executable), then release the " +
        "slot and propagate the child's exit code. Everything after -- reaches " +
        "the child untouched.",
    )
    .passThroughOptions()
    .requiredOption("--resource <name>", 'Admission resource to queue on, e.g. "browser-qa".')
    .option("--capacity <n>", "Concurrent holders this machine should allow (1-32; default 1).")
    .option("--timeout <minutes>", "Maximum admission wait before giving up (1-1440; default 60).")
    .option(
      "--label <text>",
      "Holder description shown in status listings (default: the command itself).",
    )
    .argument("<command...>", "Command to run while holding the slot.")
    .addHelpText(
      "after",
      "\nExit codes: the child's exit code · 4 admission timeout · 1 usage error, " +
        "spawn failure, or child killed by a signal.",
    )
    .action(async (commandArgs: string[], opts: AdmissionRunOpts) => {
      const capacity = parseBoundedInt(opts.capacity, 1, 1, 32);
      if (capacity === undefined) {
        emit.error({
          code: "admission_usage",
          message: "--capacity must be an integer between 1 and 32",
        });
        process.exitCode = 1;
        return;
      }
      const timeoutMinutes = parseBoundedInt(opts.timeout, 60, 1, 1440);
      if (timeoutMinutes === undefined) {
        emit.error({
          code: "admission_usage",
          message: "--timeout must be an integer number of minutes between 1 and 1440",
        });
        process.exitCode = 1;
        return;
      }
      const joined = commandArgs.join(" ");
      const label =
        opts.label ??
        (joined.length > LABEL_MAX_CHARS ? `${joined.slice(0, LABEL_MAX_CHARS - 3)}...` : joined);

      const dir = admissionBaseDir();
      let lastWaitMessage = "";
      let handle: Awaited<ReturnType<typeof acquireAdmission>>;
      try {
        handle = await acquireAdmission(
          { dir, resource: opts.resource, capacity },
          {
            label,
            timeoutMs: timeoutMinutes * 60_000,
            onWait: (info) => {
              const holders = info.holders.map((holder) => holder.label).join(", ") || "none";
              const message =
                `queued for a ${opts.resource} slot: position ${info.position}, ` +
                `capacity ${capacity}, holder(s): ${holders}`;
              if (message !== lastWaitMessage) {
                lastWaitMessage = message;
                emit.log(message, "info");
              }
            },
          },
        );
      } catch (err: unknown) {
        if (err instanceof AdmissionTimeoutError) {
          emit.error({
            code: "admission_timeout",
            message: err.message,
            hint: `${resolveBinName()} admission status --resource ${opts.resource} lists current holders`,
          });
          process.exitCode = 4;
          return;
        }
        throw err;
      }

      const [executable, ...childArgs] = commandArgs;
      try {
        const outcome = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolvePromise, rejectPromise) => {
          const child = spawn(executable as string, childArgs, {
            stdio: "inherit",
            shell: false,
          });
          child.on("error", rejectPromise);
          child.on("exit", (code, signal) => resolvePromise({ code, signal }));
        });
        if (outcome.signal !== null) {
          emit.error({
            code: "admission_child_signal",
            message: `${executable} was terminated by signal ${outcome.signal}`,
          });
          process.exitCode = 1;
          return;
        }
        process.exitCode = outcome.code ?? 1;
      } catch (err: unknown) {
        emit.error({
          code: "admission_spawn_error",
          message: `cannot run ${executable}: ${err instanceof Error ? err.message : String(err)}`,
        });
        process.exitCode = 1;
      } finally {
        handle.release();
      }
    });
}
