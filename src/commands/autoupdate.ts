// `autoupdate`: inspect and drive project self-update (ADR 0229). The engine
// lives in src/core/autoupdate/; this command owns flag parsing, human/JSON
// rendering, and exit codes. `run --background` is what the activity tick
// launches; people and agents use `status`, `check`, and `run`.

import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveCoordRoot } from "../core/agents/coord-client.ts";
import {
  type AutoUpdateDeps,
  autoUpdateStatus,
  checkForUpdate,
  runAutoUpdate,
} from "../core/autoupdate/engine.ts";
import { readAutoUpdateState } from "../core/autoupdate/state.ts";
import {
  AUTOUPDATE_DEFAULTS,
  EXIT_NEEDS_PERSON,
  type RunOutcome,
} from "../core/autoupdate/types.ts";
import { readAutoUpdateConfig } from "../core/config.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AutoUpdateCommandOptions {
  /** Project root override (tests). */
  root?: () => string;
  deps?: AutoUpdateDeps;
}

function emitLine(emit: EmitContext, s: string): void {
  emit.text(s.endsWith("\n") ? s : `${s}\n`);
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "none";
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

export function exitCodeForOutcome(outcome: RunOutcome): number {
  if (outcome === "failed") return 1;
  if (outcome === "blocked") return EXIT_NEEDS_PERSON;
  return 0;
}

export function registerAutoUpdateCommand(
  program: Command,
  emit: EmitContext,
  binName: string,
  options: AutoUpdateCommandOptions = {},
): void {
  const root = options.root ?? (() => resolveCoordRoot() ?? process.cwd());
  const deps = options.deps ?? {};

  const guard =
    <A extends unknown[]>(fn: (...args: A) => void | Promise<void>) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (err) {
        emit.error({ code: "autoupdate_error", message: (err as Error)?.message ?? String(err) });
        emit.setExitCode(1);
      }
    };

  const cmd = program
    .command("autoupdate")
    .description(
      "Project self-update: activity checks the upstream branch and watched paths, and runs " +
        "the steps configured in .harnery/config.jsonc `autoUpdate` only when something changed.",
    )
    .addHelpText(
      "after",
      `\nEnable per project with "autoUpdate": { "enabled": true, "steps": [[...]] } in .harnery/config.jsonc.\n` +
        `Exit codes: 0 current/updated · 1 failed · ${EXIT_NEEDS_PERSON} blocked (needs a person).\n` +
        `Start with \`${binName} autoupdate status\`.`,
    );

  cmd
    .command("status")
    .description(
      "Show configuration, the last run, the converged head, notices, and the next check.",
    )
    .option("--json", "Emit the status as JSON.")
    .action(
      guard((opts: { json?: boolean }) => {
        const status = autoUpdateStatus(root(), deps);
        const now = (deps.now ?? Date.now)();
        const recent = status.state.notices.filter((n) => now - Date.parse(n.at) < DAY_MS).length;
        if (opts.json) {
          emit.data({
            enabled: status.config?.enabled ?? false,
            config: status.config,
            lastRun: status.state.lastRun ?? null,
            converged: status.state.converged ?? null,
            dailyAt: status.state.dailyAt ?? null,
            cleanupAt: status.state.cleanupAt ?? null,
            notices: status.state.notices.length,
            recentNotices: recent,
            stampAgeMs: status.stampAge,
            nextCheckMs: status.nextCheckMs,
            lock: status.locked.held
              ? {
                  owner: status.locked.owner,
                  stale: status.locked.stale,
                  ageMs: status.locked.ageMs,
                }
              : null,
          });
          return;
        }
        const cfg = status.config;
        const lines: string[] = [];
        if (!cfg) {
          lines.push(
            "Auto-update is not configured (no `autoUpdate` section in .harnery/config.jsonc).",
          );
          emitLine(emit, lines.join("\n"));
          return;
        }
        lines.push(`Enabled: ${cfg.enabled ? "yes" : "no"}`);
        lines.push(`Check every: ${cfg.checkMinutes} min`);
        lines.push(
          `Steps: ${cfg.steps.length ? cfg.steps.map((s) => s.join(" ")).join("; ") : "none"}`,
        );
        if (cfg.dailySteps.length) {
          lines.push(`Daily steps: ${cfg.dailySteps.map((s) => s.join(" ")).join("; ")}`);
        }
        const last = status.state.lastRun;
        if (last) {
          lines.push(
            `Last run: ${last.outcome} (${last.reason}) at ${last.finishedAt}, ${short(last.fromHead)} -> ${short(last.toHead)}`,
          );
          if (last.error) lines.push(`Last error: ${last.error}`);
        } else {
          lines.push("Last run: never");
        }
        lines.push(`Converged head: ${short(status.state.converged?.head)}`);
        lines.push(`Notices in the last 24 h: ${recent}`);
        if (status.locked.held) {
          const owner = status.locked.owner;
          lines.push(
            `Running now: ${owner ? `pid ${owner.pid} since ${owner.at}` : "lock held"}${status.locked.stale ? " (stale)" : ""}`,
          );
        }
        if (cfg.enabled) {
          lines.push(
            `Next check: ${status.nextCheckMs ? `in ${formatDuration(status.nextCheckMs)}` : "due on the next activity"}`,
          );
        }
        emitLine(emit, lines.join("\n"));
      }),
    );

  cmd
    .command("check")
    .description("Decide whether an update is needed without running any step.")
    .option("--json", "Emit the decision as JSON.")
    .action(
      guard((opts: { json?: boolean }) => {
        const projectRoot = root();
        const cfg = (deps.readConfig ?? readAutoUpdateConfig)(projectRoot);
        if (!cfg) {
          if (opts.json) emit.data({ needed: false, reason: "disabled" });
          else emitLine(emit, "Auto-update is not configured.");
          return;
        }
        const decision = checkForUpdate(projectRoot, cfg, readAutoUpdateState(projectRoot), deps);
        if (opts.json) {
          emit.data(decision);
          return;
        }
        emitLine(
          emit,
          [
            `${decision.needed ? "Update needed" : "No update needed"}: ${decision.reason}${decision.detail ? ` (${decision.detail})` : ""}`,
            `Head: ${short(decision.head)}${decision.upstream ? ` · upstream ${decision.upstream} at ${short(decision.remoteSha)}` : ""}`,
            ...(cfg.enabled ? [] : ["Auto-update is disabled; activity will not run it."]),
          ].join("\n"),
        );
      }),
    );

  cmd
    .command("run")
    .description("Run the configured steps now if an update is needed (or always with --force).")
    .option("--force", "Run the steps even when the checkout is current.")
    .option("--background", "Write output to the log only (used by the activity tick).")
    .option("--json", "Emit the run result as JSON.")
    .action(
      guard(async (opts: { force?: boolean; background?: boolean; json?: boolean }) => {
        const projectRoot = root();
        const result = await runAutoUpdate(projectRoot, {
          force: opts.force,
          background: opts.background,
          deps,
          onOutput: opts.background
            ? undefined
            : (chunk, stream) => {
                // Keep stdout clean for --json.
                const out = opts.json || stream === "stderr" ? process.stderr : process.stdout;
                out.write(chunk);
              },
        });
        emit.setExitCode(exitCodeForOutcome(result.outcome));
        if (opts.json) {
          emit.data({
            outcome: result.outcome,
            decision: result.decision,
            record: result.record,
            notices: result.notices,
            ...(result.outcome === "skipped-locked" ? { lockOwner: result.lockOwner ?? null } : {}),
          });
          return;
        }
        if (result.outcome === "skipped-locked") {
          const owner = result.lockOwner;
          emitLine(
            emit,
            `Another auto-update run holds the lock${owner ? ` (pid ${owner.pid} since ${owner.at})` : ""}; skipped.`,
          );
          return;
        }
        if (!result.record) {
          emitLine(
            emit,
            `Auto-update is disabled; pass --force to run the steps anyway or enable it in .harnery/config.jsonc.`,
          );
          return;
        }
        const r = result.record;
        const lines = [
          `Auto-update ${r.outcome} (${r.reason}): ${short(r.fromHead)} -> ${short(r.toHead)}, ${r.steps.length} step(s).`,
        ];
        for (const n of result.notices) lines.push(`notice [${n.kind}]: ${n.text}`);
        if (r.outcome === "failed") {
          lines.push(
            `Next automatic attempt after ${AUTOUPDATE_DEFAULTS.failureBackoffMinutes} min; run \`${binName} autoupdate run\` to retry now.`,
          );
        }
        emitLine(emit, lines.join("\n"));
      }),
    );
}
