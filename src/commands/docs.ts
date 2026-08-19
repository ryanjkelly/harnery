import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { createDocsFile } from "../lib/docs-new.ts";
import { initDocsContext as initDocs, scanDocs } from "../lib/docs.ts";
import { initDocsContext as initDocsIndex, runIndex } from "../lib/docs-index.ts";
import { initDocsContext as initDocsLinks, runLinks } from "../lib/docs-links.ts";
import { initDocsContext as initDocsLint, runLint } from "../lib/docs-lint.ts";
import { readDocsMetadata, readDocsMetadataKey } from "../lib/docs-meta.ts";
import { initDocsMetadataAuditContext, runDocsMetadataAudit } from "../lib/docs-metadata-audit.ts";
import { initDocsMetadataSyncContext, runDocsMetadataSync } from "../lib/docs-metadata-sync.ts";
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
  initDocsLinks({ ...opts, extraExcludedPrefixes: context.extraDocsExcludedPrefixes });
  initDocsMetadataAuditContext(opts);
  initDocsMetadataSyncContext(opts);
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
    .description("Documentation tooling: freshness report, metadata, lint, sweep, index")
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
    .command("meta")
    .description("Read YAML frontmatter from a documentation file")
    .argument("<path>", "Markdown file path, relative to the project root or absolute")
    .argument("[key]", "Optional top-level frontmatter key")
    .option("--json", "Emit a requested key as JSON even in an interactive terminal")
    .action(async (path: string, key: string | undefined, opts: { json?: boolean }) => {
      try {
        ensureContext(context);
        handleMeta(context!.repoRoot!, path, key, opts);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "docs_error", message: msg });
      }
    });

  const metadata = docs
    .command("metadata")
    .description("Validate and maintain the versioned markdown metadata contract");

  metadata
    .command("validate")
    .description("Validate every managed Markdown file against harnery-doc/v2")
    .option("--repo <name>", "Limit to one submodule or '.' for parent")
    .action(async (opts: { repo?: string }) => {
      try {
        ensureContext(context);
        const rows = await runDocsMetadataAudit(opts);
        const errors = rows
          .flatMap((row) => row.issues)
          .filter((issue) => issue.severity === "error");
        const warnings = rows
          .flatMap((row) => row.issues)
          .filter((issue) => issue.severity === "warning");
        emit.data({
          repo: opts.repo ?? null,
          counts: {
            files: rows.length,
            valid: rows.filter((row) => row.state === "valid").length,
            invalid: rows.filter((row) => row.state === "invalid").length,
            legacy: rows.filter((row) => row.state === "legacy").length,
            missing: rows.filter((row) => row.state === "missing").length,
            errors: errors.length,
            warnings: warnings.length,
          },
          rows,
        });
        if (errors.length > 0) emit.setExitCode(1);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        emit.error({ code: "docs_error", message: msg });
      }
    });

  metadata
    .command("sync")
    .description("Synchronize semantic and lifecycle timestamps on staged v2 documents")
    .argument("[files...]", "Explicit repository-relative Markdown files; defaults to staged files")
    .option("--repo <name>", "Limit to one submodule or '.' for parent")
    .option("--check", "Report timestamp drift without writing")
    .option("--reviewed", "Record an explicit runbook review and move its due date")
    .action(
      async (files: string[], opts: { repo?: string; check?: boolean; reviewed?: boolean }) => {
        try {
          ensureContext(context);
          const rows = await runDocsMetadataSync({ ...opts, files });
          emit.data({
            check: !!opts.check,
            counts: {
              files: rows.length,
              updated: rows.filter((row) => row.status === "updated").length,
              drift: rows.filter((row) => row.status === "drift").length,
              invalid: rows.filter((row) => row.status === "invalid").length,
            },
            rows,
          });
          if (rows.some((row) => row.status === "drift" || row.status === "invalid")) {
            emit.setExitCode(1);
          }
        } catch (err: unknown) {
          emit.error({
            code: "docs_error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );

  docs
    .command("new")
    .description("Create a document with canonical harnery-doc/v2 metadata")
    .argument("<type>", "plan, issue, handoff, runbook, or topic")
    .argument("<path>", "Repository-relative Markdown path")
    .requiredOption("--summary <text>", "One-sentence document summary")
    .requiredOption("--owner <id>", "Canonical lowercase kebab-case owner id")
    .option("--status <status>", "Initial lifecycle status")
    .option("--severity <severity>", "Issue severity", "medium")
    .action(
      (
        type: "plan" | "issue" | "handoff" | "runbook" | "topic",
        path: string,
        opts: { summary: string; owner: string; status?: string; severity?: string },
      ) => {
        try {
          ensureContext(context);
          if (!["plan", "issue", "handoff", "runbook", "topic"].includes(type)) {
            throw new Error(`unsupported document type '${type}'`);
          }
          const file = createDocsFile(context!.repoRoot!, { type, path, ...opts });
          emit.data({ path: file, schema: "harnery-doc/v2", type });
        } catch (err: unknown) {
          emit.error({
            code: "docs_error",
            message: err instanceof Error ? err.message : String(err),
          });
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
    .command("links")
    .description("Check internal Markdown link targets and heading fragments")
    .option("--repo <name>", "Limit to one submodule or '.' for parent")
    .option("--no-fragments", "Check target existence only; skip heading-fragment validation")
    .option("--strict", "Report findings in archive/audit/changelog docs as errors, not warnings")
    .option("--check-escapes", "Also flag links that resolve outside their own repo root")
    .option("--fail", "Exit non-zero when errors are found (advisory by default)")
    .option("--format <type>", "Output format: human, json", "human")
    .action(
      async (opts: {
        repo?: string;
        fragments?: boolean;
        strict?: boolean;
        checkEscapes?: boolean;
        fail?: boolean;
        format: string;
      }) => {
        try {
          ensureContext(context);
          await handleLinks(opts);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          emit.error({ code: "docs_error", message: msg });
        }
      },
    );

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
    .option("--repo <name>", "Limit to one package (in-tree or submodule) or '.' for parent")
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

// --- `harn docs meta` ---

function handleMeta(
  repoRoot: string,
  path: string,
  key: string | undefined,
  opts: { json?: boolean },
): void {
  const metadata = readDocsMetadata(repoRoot, path).data;
  if (!key) {
    emit.data(metadata);
    return;
  }

  const value = readDocsMetadataKey(metadata, key, path);
  if (opts.json || !process.stdout.isTTY || typeof value === "object") {
    emit.data(value);
    return;
  }
  emit.text(String(value));
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

// --- `harn docs links` ---

/**
 * Advisory by default: a clean exit code even with findings, because turning
 * link health into a gate is an enforcement policy decision for the host, not
 * something this command should assume. `--fail` is the opt-in for CI or a hook.
 */
async function handleLinks(opts: {
  repo?: string;
  fragments?: boolean;
  strict?: boolean;
  checkEscapes?: boolean;
  fail?: boolean;
  format: string;
}): Promise<void> {
  if (opts.format === "json") emit.config({ format: "json" });
  const report = await runLinks({
    repo: opts.repo,
    noFragments: opts.fragments === false,
    strict: opts.strict,
    checkEscapes: opts.checkEscapes,
  });
  emit.data({ ...report, advisory: !opts.fail });
  if (opts.fail && report.error_count > 0) emit.setExitCode(1);
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
