import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { initDocsContext as initDocs, scanDocs } from "../lib/docs.ts";
import { initDocsContext as initDocsIndex, runIndex } from "../lib/docs-index.ts";
import { initDocsContext as initDocsLint, runLint } from "../lib/docs-lint.ts";
import {
  countColdHandoffs,
  initDocsContext as initDocsSweep,
  runSweep,
} from "../lib/docs-sweep.ts";

function ensureContext(context: HarneryProgramContext | undefined): void {
  if (!context?.repoRoot || !context?.submodules) {
    throw new Error("docs commands require harnery to be configured with repoRoot + submodules");
  }
  const opts = { repoRoot: context.repoRoot, submodules: context.submodules };
  initDocs(opts);
  initDocsIndex(opts);
  initDocsLint({
    ...opts,
    extraExcludedPrefixes: context.extraDocsExcludedPrefixes,
    docsRootAllowlist: context.docsRootAllowlist,
  });
  initDocsSweep(opts);
}

let emit: EmitContext;

export function registerDocsCommand(
  program: Command,
  emitParam: EmitContext,
  context?: HarneryProgramContext,
): void {
  emit = emitParam;
  const docs = program
    .command("docs")
    .description("Documentation tooling: freshness report, lint, sweep, index")
    // Options on the group itself back the default (no-subcommand) behavior.
    // See handleDocs below.
    .option("--stale <days>", "Only show files not committed in N+ days", Number.parseInt)
    .option("--dir <name>", "Filter to a specific top-level directory")
    .option("--no-submodules", "Exclude submodule files; only show parent repo docs")
    .option("--commits <n>", "Number of recent commits to show per file", Number.parseInt, 1)
    .option("--format <type>", "Output format: table, csv, json", "table")
    .action(
      async (opts: {
        stale?: number;
        dir?: string;
        submodules?: boolean;
        commits: number;
        format: string;
      }) => {
        try {
          ensureContext(context);
          await handleDocs(opts);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          emit.error({ code: "docs_error", message: msg });
        }
      },
    );

  docs
    .command("lint")
    .description(
      "Verify every repo matches the documentation contract (directory layout + naming rules)",
    )
    .option("--fast", "Skip content-reading checks; filename/structure only (for pre-commit)")
    .option("--repo <name>", "Limit to one submodule or '.' for parent")
    .option("--format <type>", "Output format: human, json", "human")
    .action(async (opts: { fast?: boolean; repo?: string; format: string }) => {
      try {
        ensureContext(context);
        await handleLint(opts);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "docs_error", message: msg });
      }
    });

  docs
    .command("sweep")
    .description(
      "Surface stalled lifecycle states: stalled plans, cold issues, unverified runbooks",
    )
    .option("--repo <name>", "Limit to one submodule or '.' for parent")
    .option("--format <type>", "Output format: human, json", "human")
    .action(async (opts: { repo?: string; format: string }) => {
      try {
        ensureContext(context);
        await handleSweep(opts);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "docs_error", message: msg });
      }
    });

  docs
    .command("index")
    .description("Regenerate index READMEs for docs/audits/ and docs/issues/ directories")
    .option("--dry-run", "Show what would change, don't write files")
    .option("--repo <name>", "Limit to one submodule or '.' for parent")
    .action(async (opts: { dryRun?: boolean; repo?: string }) => {
      try {
        ensureContext(context);
        await handleIndex(opts);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "docs_error", message: msg });
      }
    });
}

// --- Default `harn docs` (freshness report) ---

async function handleDocs(opts: {
  stale?: number;
  dir?: string;
  submodules?: boolean;
  commits: number;
  format: string;
}): Promise<void> {
  if (opts.format === "json") emit.config({ format: "json" });
  else if (opts.format === "csv") emit.config({ format: "csv" });

  const files = await scanDocs({
    commitCount: opts.commits,
    dir: opts.dir,
    noSubmodules: opts.submodules === false,
    staleDays: opts.stale,
  });
  emit.rows(files as unknown as Record<string, unknown>[]);
}

// --- `harn docs lint` ---

async function handleLint(opts: { fast?: boolean; repo?: string; format: string }): Promise<void> {
  const violations = await runLint({ fast: opts.fast, repo: opts.repo });
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  const cold = await countColdHandoffs();

  emit.data({
    fast: !!opts.fast,
    repo: opts.repo ?? null,
    error_count: errors.length,
    warning_count: warnings.length,
    cold_handoffs: cold,
    violations,
  });

  if (errors.length > 0) emit.setExitCode(1);
}

// --- `harn docs sweep` ---

async function handleSweep(opts: { repo?: string; format: string }): Promise<void> {
  if (opts.format === "json") emit.config({ format: "json" });
  const items = await runSweep({ repo: opts.repo });
  emit.data(items);
}

// --- `harn docs index` ---

async function handleIndex(opts: { dryRun?: boolean; repo?: string }): Promise<void> {
  const results = await runIndex({ dryRun: opts.dryRun, repo: opts.repo });
  emit.data({
    dry_run: !!opts.dryRun,
    repo: opts.repo ?? null,
    counts: {
      updated: results.filter((r) => r.status === "updated").length,
      created: results.filter((r) => r.status === "created").length,
      needs_markers: results.filter((r) => r.status === "needs-markers").length,
      unchanged: results.filter((r) => r.status === "unchanged").length,
    },
    results,
  });
}
