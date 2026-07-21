import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import {
  type BenchResult,
  createBuiltinHarnessRegistry,
  type HarnessBenchReport,
  runHarnessBench,
} from "../core/harnesses/index.ts";
import type { HarnessProfile } from "../core/harnesses/types.ts";

interface FormatOpts {
  json?: boolean;
}

interface BenchOpts extends FormatOpts {
  requireInstalled?: boolean;
}

const registry = createBuiltinHarnessRegistry();

export function registerHarnessCommand(program: Command, emit: EmitContext): void {
  const command = program
    .command("harness")
    .description("Inspect registered harness capabilities and run their conformance bench.");

  command
    .command("list")
    .description("List registered harness adapters and their high-signal capability claims.")
    .option("--json", "Machine-readable profile catalog")
    .action((opts: FormatOpts) => {
      const profiles = registry.list().map((adapter) => adapter.profile);
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data({ harnesses: profiles });
      } else {
        emit.text(renderProfileTable(profiles));
      }
    });

  command
    .command("show <id>")
    .description("Show one harness's complete capability declaration.")
    .option("--json", "Machine-readable profile")
    .action((id: string, opts: FormatOpts) => {
      const adapter = registry.get(id);
      if (!adapter) {
        emit.error({
          code: "unknown_harness",
          message: `unknown harness ${JSON.stringify(id)} (registered: ${registry.ids().join(", ")})`,
        });
        emit.setExitCode(1);
        return;
      }
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data(adapter.profile);
      } else {
        emit.text(renderProfile(adapter.profile));
      }
    });

  command
    .command("bench [harnesses...]")
    .description("Run the offline adapter-contract bench (no model calls); drift exits non-zero.")
    .option("--require-installed", "Also fail when a registered vendor CLI is missing")
    .option("--json", "Machine-readable conformance report")
    .action((harnesses: string[], opts: BenchOpts) => {
      try {
        const report = runHarnessBench(registry, { harnesses });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(report);
        } else {
          emit.text(renderBenchReport(report));
        }
        emit.setExitCode(report.drift || (opts.requireInstalled && report.skipped) ? 1 : 0);
      } catch (error) {
        emit.error({ code: "harness_bench_failed", message: (error as Error).message });
        emit.setExitCode(1);
      }
    });
}

export function renderProfileTable(profiles: readonly HarnessProfile[]): string {
  const rows = profiles.map((profile) => [
    profile.id,
    profile.binary,
    profile.capabilities.modelSelection.support,
    profile.capabilities.effortSelection.support,
    profile.capabilities.sessionId.support,
    profile.capabilities.cost.support,
  ]);
  return renderTable(["HARNESS", "BINARY", "MODEL", "EFFORT", "SESSION", "COST"], rows);
}

export function renderProfile(profile: HarnessProfile): string {
  const lines = [
    `${profile.displayName} (${profile.id})`,
    `binary: ${profile.binary}`,
    `integration: ${profile.integrationMode}`,
    `auth: ${profile.authModel}`,
    `model family: ${profile.modelFamily}`,
    `effort values: ${profile.effortValues.join(", ") || "none"}`,
    profile.verified
      ? `verified: ${profile.verified.date} (${profile.verified.version})`
      : "verified: not recorded",
    "",
    "capabilities:",
  ];
  for (const [dimension, claim] of Object.entries(profile.capabilities)) {
    lines.push(`  ${dimension.padEnd(18)} ${claim.support}${claim.note ? ` — ${claim.note}` : ""}`);
  }
  return lines.join("\n");
}

export function renderBenchReport(report: HarnessBenchReport): string {
  const rows = report.results.map((result) => [
    result.harness,
    result.dimension,
    result.declared,
    result.observed,
    result.verdict,
  ]);
  const table = renderTable(["HARNESS", "DIMENSION", "DECLARED", "OBSERVED", "VERDICT"], rows);
  const summary = Object.entries(report.summary)
    .filter(([, count]) => count > 0)
    .map(([verdict, count]) => `${verdict}=${count}`)
    .join(", ");
  return `${table}\n\nmode: ${report.mode} (no model calls)\n${summary}`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join(
    "\n",
  );
}

/** Kept exported so command tests can assert row semantics without model calls. */
export type { BenchResult };
