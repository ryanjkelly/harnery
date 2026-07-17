import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
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
        emit.text(
          `run ${report.runId} (${report.name}) finished: ${report.agentsSpawned} agent(s)${cachedPart}, ` +
            `$${report.costUsd.toFixed(4)}, ${Math.round(report.durationMs / 1000)}s\n` +
            `journal: ${report.journalPath}\n` +
            `result: ${typeof report.result === "string" ? report.result : JSON.stringify(report.result, null, 2)}\n`,
        );
      } catch (err) {
        emit.error({ code: "workflow_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}
