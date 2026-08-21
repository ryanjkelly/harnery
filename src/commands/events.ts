import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  type LatencyMetricV3,
  projectEconomicsV3,
  projectLatencyV3,
  readLedgerV3,
  type ToolLatencyV3,
  type TurnLatencyV3,
} from "../core/events/v3/index.ts";

interface LatencyOptions {
  root?: string;
  json?: boolean;
  candidate?: boolean;
  byTool?: boolean;
  byGeneration?: boolean;
}

interface GenerationLatencyRow {
  generation_id: string;
  turns: number;
  wall_ms: LatencyMetricV3;
  tool_ms: LatencyMetricV3;
  command_ms: LatencyMetricV3;
  wait_ms: LatencyMetricV3;
  agent_action_ms: LatencyMetricV3;
  inference_ms: LatencyMetricV3;
  harness_ms: LatencyMetricV3;
  residual_ms: LatencyMetricV3;
}

interface ToolLatencyRow extends ToolLatencyV3 {
  coverage: "complete" | "partial";
}

/** Read-only projections over the canonical Event Ledger V3 stream. */
export function registerEventsCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const command = program.command("events").description("Inspect the canonical event ledger");

  command
    .command("latency")
    .description("Project turn latency, token economics, and attribution from Event Ledger V3")
    .option("--root <path>", "Explicit coordination root")
    .option("--candidate", "Read a pre-activation candidate ledger instead of active authority")
    .option("--by-tool", "Aggregate inclusive tool latency")
    .option("--by-generation", "Aggregate latency by generation")
    .option("--json", "Emit the complete projections and selected view as JSON")
    .action((options: LatencyOptions) => {
      try {
        if (options.byTool && options.byGeneration) {
          throw new Error("--by-tool and --by-generation are mutually exclusive");
        }
        const root = resolve(options.root ?? coordRoot(context));
        const authority = options.candidate ? "candidate" : "active";
        const read = readLedgerV3(root, { authority });
        if (!read.complete) {
          const diagnostics = read.diagnostics.map(({ code }) => code).join(", ") || "unknown";
          throw new Error(`V3 ledger read is incomplete: ${diagnostics}`);
        }
        const latency = projectLatencyV3(read);
        const economics = projectEconomicsV3(read);
        const view = options.byTool
          ? { kind: "tool" as const, rows: summarizeByTool(latency.turns) }
          : options.byGeneration
            ? { kind: "generation" as const, rows: summarizeByGeneration(latency.turns) }
            : { kind: "turn" as const, rows: latency.turns };

        if (options.json) {
          emit.config({ format: "json" });
          emit.data({ root, authority, view, latency, economics });
          return;
        }
        if (view.kind === "tool") emit.text(renderTools(view.rows));
        else if (view.kind === "generation") emit.text(renderGenerations(view.rows));
        else emit.text(renderTurns(view.rows));
      } catch (error) {
        emit.error({
          code: "event_v3_latency_failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
}

function coordRoot(context: HarneryProgramContext | undefined): string {
  return resolve(
    context?.resolveCoordRoot?.() ??
      context?.repoRoot ??
      process.env.HARNERY_COORD_ROOT ??
      process.cwd(),
  );
}

function summarizeByGeneration(turns: TurnLatencyV3[]): GenerationLatencyRow[] {
  const groups = new Map<string, TurnLatencyV3[]>();
  for (const turn of turns) {
    const group = groups.get(turn.generation_id) ?? [];
    group.push(turn);
    groups.set(turn.generation_id, group);
  }
  return [...groups.entries()]
    .map(([generationId, group]) => ({
      generation_id: generationId,
      turns: group.length,
      wall_ms: sumMetrics(group.map(({ wall_ms }) => wall_ms)),
      tool_ms: sumMetrics(group.map(({ tool_ms }) => tool_ms)),
      command_ms: sumMetrics(group.map(({ command_exclusive_ms }) => command_exclusive_ms)),
      wait_ms: sumMetrics(group.map(({ wait_ms }) => wait_ms)),
      agent_action_ms: sumMetrics(
        group.map(({ response_latency }) => response_latency.agent_action_ms),
      ),
      inference_ms: sumMetrics(group.map(({ inference_ms }) => inference_ms)),
      harness_ms: sumMetrics(group.map(({ harness_ms }) => harness_ms)),
      residual_ms: sumMetrics(group.map(({ residual_ms }) => residual_ms)),
    }))
    .sort((left, right) => left.generation_id.localeCompare(right.generation_id));
}

function summarizeByTool(turns: TurnLatencyV3[]): ToolLatencyRow[] {
  const groups = new Map<string, ToolLatencyV3[]>();
  for (const turn of turns) {
    for (const tool of turn.tool_breakdown) {
      const key = `${tool.namespace}\0${tool.name}`;
      const group = groups.get(key) ?? [];
      group.push(tool);
      groups.set(key, group);
    }
  }
  const rows: ToolLatencyRow[] = [...groups.entries()].map(([key, group]) => {
    const [namespace, name] = key.split("\0");
    return {
      namespace: namespace ?? "",
      name: name ?? "",
      count: group.reduce((total, tool) => total + tool.count, 0),
      duration_ms: sumMetrics(group.map(({ duration_ms }) => duration_ms)),
      coverage: "complete",
    };
  });
  const incomplete = turns.filter(({ tool_ms }) => tool_ms.state === "unknown");
  if (incomplete.length > 0) {
    rows.push({
      namespace: "?",
      name: "unattributed",
      count: 0,
      duration_ms: {
        state: "unknown",
        known_ms: 0,
        reasons: unique(
          incomplete.flatMap(({ tool_ms }) => (tool_ms.state === "unknown" ? tool_ms.reasons : [])),
        ),
      },
      coverage: "partial",
    });
  }
  return rows.sort(
    (left, right) =>
      left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name),
  );
}

function sumMetrics(metrics: LatencyMetricV3[]): LatencyMetricV3 {
  const known = metrics.reduce((total, metric) => total + metricValue(metric), 0);
  const reasons = unique(
    metrics.flatMap((metric) => (metric.state === "unknown" ? metric.reasons : [])),
  );
  return reasons.length === 0
    ? { state: "observed", value_ms: known }
    : { state: "unknown", known_ms: known, reasons };
}

function renderTurns(turns: TurnLatencyV3[]): string {
  return renderTable(
    [
      "GENERATION",
      "TURN",
      "WALL",
      "TOOL",
      "COMMAND",
      "WAIT",
      "ACTION",
      "POST-TOOL",
      "INFERENCE",
      "HARNESS",
      "RESIDUAL",
      "CONTEXT",
    ],
    turns.map((turn) => [
      turn.generation_id,
      turn.turn_id,
      formatMetric(turn.wall_ms),
      formatMetric(turn.tool_ms),
      formatMetric(turn.command_exclusive_ms),
      formatMetric(turn.wait_ms),
      formatMetric(turn.response_latency.agent_action_ms),
      formatMetric(turn.response_latency.post_tool_response_ms),
      formatMetric(turn.inference_ms),
      formatMetric(turn.harness_ms),
      formatMetric(turn.residual_ms),
      turn.context_percent === null ? "?" : `${turn.context_percent.toFixed(1)}%`,
    ]),
  );
}

function renderGenerations(rows: GenerationLatencyRow[]): string {
  return renderTable(
    [
      "GENERATION",
      "TURNS",
      "WALL",
      "TOOL",
      "COMMAND",
      "WAIT",
      "ACTION",
      "INFERENCE",
      "HARNESS",
      "RESIDUAL",
    ],
    rows.map((row) => [
      row.generation_id,
      String(row.turns),
      formatMetric(row.wall_ms),
      formatMetric(row.tool_ms),
      formatMetric(row.command_ms),
      formatMetric(row.wait_ms),
      formatMetric(row.agent_action_ms),
      formatMetric(row.inference_ms),
      formatMetric(row.harness_ms),
      formatMetric(row.residual_ms),
    ]),
  );
}

function renderTools(rows: ToolLatencyRow[]): string {
  return renderTable(
    ["NAMESPACE", "TOOL", "CALLS", "INCLUSIVE", "COVERAGE"],
    rows.map((row) => [
      row.namespace,
      row.name,
      String(row.count),
      formatMetric(row.duration_ms),
      row.coverage,
    ]),
  );
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  const line = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();
  return `${[line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n")}\n`;
}

function formatMetric(metric: LatencyMetricV3): string {
  if (metric.state === "observed") return `${metric.value_ms}ms`;
  return metric.known_ms > 0 ? `>=${metric.known_ms}ms?` : "?";
}

function metricValue(metric: LatencyMetricV3): number {
  return metric.state === "observed" ? metric.value_ms : metric.known_ms;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
