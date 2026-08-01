import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import {
  type AdapterAttestationReport,
  type AdapterBenchReport,
  type BenchResult,
  createBuiltinAdapterRegistry,
  listAttestations,
  runAdapterAttestation,
  runAdapterBench,
} from "../core/adapters/index.ts";
import type { AdapterProfile } from "../core/adapters/types.ts";
import { workflowSubscriptionOnly } from "../core/config.ts";

interface FormatOpts {
  json?: boolean;
}

interface BenchOpts extends FormatOpts {
  requireInstalled?: boolean;
}

interface AttestOpts extends FormatOpts {
  timeout?: string;
  yes?: boolean;
  subscriptionOnly?: boolean;
  projection?: boolean;
}

const registry = createBuiltinAdapterRegistry();

export function registerAdapterCommand(program: Command, emit: EmitContext): void {
  const command = program
    .command("adapter")
    .description("Inspect registered adapter capabilities and run their conformance bench.");

  command
    .command("list")
    .description("List registered adapter adapters and their high-signal capability claims.")
    .option("--json", "Machine-readable profile catalog")
    .action((opts: FormatOpts) => {
      const profiles = registry.list().map((adapter) => adapter.profile);
      if (opts.json) {
        emit.config({ format: "json" });
        emit.data({ adapters: profiles });
      } else {
        emit.text(renderProfileTable(profiles));
      }
    });

  command
    .command("show <id>")
    .description("Show one adapter's complete capability declaration.")
    .option("--json", "Machine-readable profile")
    .action((id: string, opts: FormatOpts) => {
      const adapter = registry.get(id);
      if (!adapter) {
        emit.error({
          code: "unknown_adapter",
          message: `unknown adapter ${JSON.stringify(id)} (registered: ${registry.ids().join(", ")})`,
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
    .command("bench [adapters...]")
    .description("Run the offline adapter-contract bench (no model calls); drift exits non-zero.")
    .option("--require-installed", "Also fail when a registered vendor CLI is missing")
    .option("--json", "Machine-readable conformance report")
    .action((adapters: string[], opts: BenchOpts) => {
      try {
        const report = runAdapterBench(registry, { adapters });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(report);
        } else {
          emit.text(renderBenchReport(report));
        }
        emit.setExitCode(report.drift || (opts.requireInstalled && report.skipped) ? 1 : 0);
      } catch (error) {
        emit.error({ code: "adapter_bench_failed", message: (error as Error).message });
        emit.setExitCode(1);
      }
    });

  command
    .command("attest [adapters...]")
    .description(
      "Record what the installed vendor CLIs actually do. Runs one real model turn each; needs --yes.",
    )
    .option("--yes", "Confirm that this spends real vendor tokens")
    .option(
      "--subscription-only",
      "Scrub API-key vars so the child uses its stored login (repo default via config.jsonc workflow.subscriptionOnly)",
    )
    .option("--timeout <ms>", "Per-adapter probe timeout in milliseconds")
    .option(
      "--projection",
      "Also probe whether a declared sandbox is enforced; costs two extra turns per capable adapter",
    )
    .option("--json", "Machine-readable attestation report")
    .action(async (adapters: string[], opts: AttestOpts) => {
      if (!opts.yes) {
        emit.error({
          code: "adapter_attest_unconfirmed",
          message:
            "adapter attest runs one real model turn per adapter and spends vendor tokens. Re-run with --yes.",
        });
        emit.setExitCode(1);
        return;
      }
      const timeoutMs = opts.timeout ? Number(opts.timeout) : undefined;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        emit.error({
          code: "adapter_attest_bad_timeout",
          message: "--timeout must be a positive number",
        });
        emit.setExitCode(1);
        return;
      }
      try {
        const subscriptionOnly = opts.subscriptionOnly || workflowSubscriptionOnly();
        const report = await runAdapterAttestation(registry, {
          adapters,
          timeoutMs,
          subscriptionOnly,
          projection: opts.projection === true,
        });
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data(report);
        } else {
          emit.text(renderAttestationReport(report));
        }
        // A sweep that recorded nothing at all is a failure; a partial sweep is
        // reported honestly and still exits 0, because a host is not required
        // to install every vendor CLI.
        emit.setExitCode(report.recorded === 0 ? 1 : 0);
      } catch (error) {
        emit.error({ code: "adapter_attest_failed", message: (error as Error).message });
        emit.setExitCode(1);
      }
    });

  command
    .command("attestations")
    .description("Show the recorded live attestations without running any model turns.")
    .option("--json", "Machine-readable attestation list")
    .action((opts: FormatOpts) => {
      try {
        const records = listAttestations();
        if (opts.json) {
          emit.config({ format: "json" });
          emit.data({ attestations: records });
          return;
        }
        if (records.length === 0) {
          emit.text("No attestations recorded. Run `adapter attest --yes` to create one.");
          return;
        }
        emit.text(
          renderTable(
            ["ADAPTER", "VERSION", "BILLING", "OBSERVED AT", "OBSERVATIONS"],
            records.map((record) => [
              record.adapter,
              record.binary_version,
              record.subscription_only ? "subscription" : "any",
              record.observed_at,
              Object.entries(record.observations)
                .map(([dimension, support]) => `${dimension}=${support}`)
                .join(" "),
            ]),
          ),
        );
      } catch (error) {
        emit.error({ code: "adapter_attestations_failed", message: (error as Error).message });
        emit.setExitCode(1);
      }
    });
}

export function renderAttestationReport(report: AdapterAttestationReport): string {
  const rows = report.results.map((result) => [
    result.adapter,
    result.outcome,
    result.binaryVersion ?? "",
    result.observations
      ? Object.entries(result.observations)
          .map(([dimension, support]) => `${dimension}=${support}`)
          .join(" ")
      : result.note,
  ]);
  const table = renderTable(["ADAPTER", "OUTCOME", "VERSION", "OBSERVED"], rows);
  const tail = report.incomplete
    ? "Some adapters were not attested; their bench rows keep an adapter basis."
    : "Every selected adapter was attested.";
  return `${table}\n\nrecorded: ${report.recorded}/${report.results.length}\n${tail}`;
}

export function renderProfileTable(profiles: readonly AdapterProfile[]): string {
  const rows = profiles.map((profile) => [
    profile.id,
    profile.binary,
    profile.capabilities.modelSelection.support,
    profile.capabilities.effortSelection.support,
    profile.capabilities.sessionId.support,
    profile.capabilities.cost.support,
  ]);
  return renderTable(["ADAPTER", "BINARY", "MODEL", "EFFORT", "SESSION", "COST"], rows);
}

export function renderProfile(profile: AdapterProfile): string {
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

export function renderBenchReport(report: AdapterBenchReport): string {
  const rows = report.results.map((result) => [
    result.adapter,
    result.dimension,
    result.declared,
    result.observed,
    result.verdict,
    result.basis,
  ]);
  const table = renderTable(
    ["ADAPTER", "DIMENSION", "DECLARED", "OBSERVED", "VERDICT", "BASIS"],
    rows,
  );
  const summary = Object.entries(report.summary)
    .filter(([, count]) => count > 0)
    .map(([verdict, count]) => `${verdict}=${count}`)
    .join(", ");
  const basis = Object.entries(report.basisSummary)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(", ");
  return [
    table,
    "",
    `mode: ${report.mode} (no model calls)`,
    summary,
    `basis: ${basis}`,
    "adapter = checked against Harnery's planner/normalizer/fixture, not the installed CLI",
  ].join("\n");
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
