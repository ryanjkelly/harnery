import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { workflowSubscriptionOnly } from "../core/config.ts";
import { findCoordRoot } from "../core/hooks/resolve/coord-root.ts";

/**
 * `workflow run <script>`: execute a workflow script — bounded, schema-gated,
 * conditionally-routed stages fanning out to headless harness-CLI subagents.
 * The script (deterministic code), not a model, decides routing between
 * stages, and the run terminates when the script returns.
 *
 * Phase 2 surface: `run` only, claude-code spawn adapter only. Design +
 * phasing: decision 0015.
 */

interface WorkflowRunOpts {
  maxAgents?: string;
  concurrency?: string;
  cwd?: string;
  harness?: string;
  resumeFrom?: string;
  subscriptionOnly?: boolean;
  allowApiBilling?: boolean;
  json?: boolean;
}

const HARNESSES = ["claude-code", "codex", "cursor"] as const;

export function registerWorkflowCommand(program: Command, emit: EmitContext): void {
  const workflow = program
    .command("workflow")
    .description("Run bounded, schema-gated multi-subagent workflow scripts.");

  workflow
    .command("run <script>")
    .description(
      "Execute a workflow script (plain JS: `export default async ({agent, parallel, stage, log}) => …`). " +
        "Subagents spawn as headless harness-CLI subprocesses, coordination-registered.",
    )
    .option("--max-agents <n>", "Total-agent ceiling for the run (default 50)")
    .option("--concurrency <n>", "Concurrent-subagent cap (default 4)")
    .option("--cwd <dir>", "Working directory children spawn in (default: coord root)")
    .option(
      "--harness <name>",
      `Default harness for agent() calls: ${HARNESSES.join(" | ")} (default claude-code); scripts can override per agent via opts.harness`,
    )
    .option(
      "--resume-from <run-id>",
      "Reuse completed agent results from a prior run's journal; only changed/failed calls re-run",
    )
    .option(
      "--subscription-only",
      "Guarantee subscription billing: scrub API-key vars from child envs; fail loud when a " +
        "harness has no stored login (repo default via config.jsonc workflow.subscriptionOnly)",
    )
    .option(
      "--allow-api-billing",
      "Permit an exported API key to override a stored subscription login (per-token billing); " +
        "without this the engine refuses that silent-override state",
    )
    .option("--json", "Emit the full RunReport as JSON")
    .action(async (script: string, opts: WorkflowRunOpts) => {
      const coordRoot = findCoordRoot();
      if (!coordRoot) {
        emit.error({
          code: "no_coord_root",
          message: "no .harnery/ coordination root found; run `init` first",
        });
        process.exit(1);
      }
      if (opts.harness && !HARNESSES.includes(opts.harness as (typeof HARNESSES)[number])) {
        emit.error({
          code: "bad_harness",
          message: `unknown harness "${opts.harness}" (expected: ${HARNESSES.join(" | ")})`,
        });
        process.exit(1);
      }
      // Flag beats config; the two flags contradict each other by design.
      const subscriptionOnly = opts.subscriptionOnly || workflowSubscriptionOnly(coordRoot);
      if (subscriptionOnly && opts.allowApiBilling) {
        emit.error({
          code: "billing_flags_conflict",
          message:
            "--allow-api-billing contradicts subscription-only mode " +
            "(flag or config.jsonc workflow.subscriptionOnly); pick one",
        });
        process.exit(1);
      }
      try {
        const [{ runWorkflow }, { claudeCodeSpawner }, { codexSpawner }, { cursorSpawner }] =
          await Promise.all([
            import("../core/workflow/engine.ts"),
            import("../core/workflow/spawn-claude.ts"),
            import("../core/workflow/spawn-codex.ts"),
            import("../core/workflow/spawn-cursor.ts"),
          ]);
        const report = await runWorkflow(script, {
          coordRoot,
          spawners: {
            "claude-code": claudeCodeSpawner,
            codex: codexSpawner,
            cursor: cursorSpawner,
          },
          defaultHarness: opts.harness as "claude-code" | "codex" | "cursor" | undefined,
          resumeFrom: opts.resumeFrom,
          subscriptionOnly,
          allowApiBilling: opts.allowApiBilling,
          maxAgents: opts.maxAgents ? Number.parseInt(opts.maxAgents, 10) : undefined,
          concurrency: opts.concurrency ? Number.parseInt(opts.concurrency, 10) : undefined,
          cwd: opts.cwd,
        });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(report);
          return;
        }
        const cachedPart = report.agentsCached > 0 ? ` (+${report.agentsCached} cached)` : "";
        const billingPart = report.billing.length
          ? `billing: ${report.billing.map((b) => `${b.harness}=${b.mode}`).join(", ")}\n`
          : "";
        emit.text(
          `run ${report.runId} (${report.name}) finished: ${report.agentsSpawned} agent(s)${cachedPart}, ` +
            `$${report.costUsd.toFixed(4)}, ${Math.round(report.durationMs / 1000)}s\n${billingPart}` +
            `journal: ${report.journalPath}\n` +
            `result: ${typeof report.result === "string" ? report.result : JSON.stringify(report.result, null, 2)}\n`,
        );
      } catch (err) {
        emit.error({ code: "workflow_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}
