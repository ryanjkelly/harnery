import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { resolveBinName } from "../core/config.ts";
import {
  countEventHistoryV3,
  type EventHistoryGroupV3,
  type EventHistoryRowV3,
  localStamp,
  parseHistoryInstantV3,
  scanEventHistoryV3,
} from "../core/events/v3/history.ts";
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

interface QueryOptions {
  root?: string;
  since?: string;
  until?: string;
  type?: string[];
  session?: string;
  tool?: string;
  outcome?: string;
  countBy?: string;
  limit?: string;
  tz?: string;
  json?: boolean;
}

const GROUPS: EventHistoryGroupV3[] = [
  "type",
  "session",
  "subject",
  "outcome",
  "day",
  "hour",
  "epoch",
];

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

  command
    .command("epochs")
    .description(
      "List every retained ledger epoch (archives plus the active one) with its time span and event count",
    )
    .option("--root <path>", "Explicit coordination root")
    .option("--tz <zone>", "IANA time zone for printed times (default: this machine's)")
    .option("--json", "Emit the epoch summaries as JSON")
    .action((options: { root?: string; tz?: string; json?: boolean }) => {
      const root = resolve(options.root ?? coordRoot(context));
      const scan = scanEventHistoryV3(root, {}, { collectRows: false });
      if (options.json) {
        emit.config({ format: "json" });
        emit.data({ root, epochs: scan.epochs });
        return;
      }
      emit.text(renderEpochs(scan.epochs, options.tz));
    });

  command
    .command("query")
    .description(
      "Search or count events across the whole retained history, archives included, not only the active epoch",
    )
    .option("--root <path>", "Explicit coordination root")
    .option("--since <when>", "Start: 30d, 12h, 90m, or an ISO date/time")
    .option("--until <when>", "End (exclusive): same forms as --since")
    .option("--type <types...>", "Event types; exact, or a prefix ending in . or * (tool. coord.*)")
    .option("--session <id>", "Instance id or prefix, with or without inst_")
    .option("--tool <name>", "Tool name or command executable (Bash, Edit, git, ...)")
    .option("--outcome <outcome>", "Completion outcome (succeeded, failed, ...)")
    .option("--count-by <field>", `Count matches instead of listing them: ${GROUPS.join(", ")}`)
    .option("--limit <n>", "Rows to list, most recent kept (default 50; 0 = all)")
    .option("--tz <zone>", "IANA time zone for printed times and day/hour groups")
    .option("--json", "Emit JSON")
    .action((options: QueryOptions) => {
      try {
        const root = resolve(options.root ?? coordRoot(context));
        const countBy = options.countBy as EventHistoryGroupV3 | undefined;
        if (countBy && !GROUPS.includes(countBy)) {
          throw new Error(`--count-by must be one of: ${GROUPS.join(", ")}`);
        }
        const limit = options.limit === undefined ? 50 : Number(options.limit);
        if (!Number.isInteger(limit) || limit < 0)
          throw new Error("--limit must be a whole number");
        const now = new Date();
        const scan = scanEventHistoryV3(root, {
          since: options.since ? parseHistoryInstantV3(options.since, now) : undefined,
          until: options.until ? parseHistoryInstantV3(options.until, now) : undefined,
          types: options.type,
          session: options.session,
          subject: options.tool,
          outcome: options.outcome,
        });
        const coverage = coverageLine(scan.epochs, scan.skipped_epochs, options.tz);
        if (countBy) {
          const counts = countEventHistoryV3(scan.rows, countBy, options.tz);
          if (options.json) {
            emit.config({ format: "json" });
            emit.data({
              root,
              matches: scan.rows.length,
              count_by: countBy,
              counts,
              epochs: scan.epochs,
            });
            return;
          }
          emit.text(
            `${renderTable(
              [countBy.toUpperCase(), "COUNT"],
              counts.map(({ key, count }) => [key, String(count)]),
            )}${scan.rows.length} matching events. ${coverage}\n`,
          );
          return;
        }
        const shown = limit === 0 ? scan.rows : scan.rows.slice(-limit);
        if (options.json) {
          emit.config({ format: "json" });
          emit.data({ root, matches: scan.rows.length, rows: shown, epochs: scan.epochs });
          return;
        }
        const note =
          shown.length < scan.rows.length
            ? `Showing the latest ${shown.length} of ${scan.rows.length} matching events (--limit 0 for all).`
            : `${scan.rows.length} matching events.`;
        emit.text(`${renderHistoryRows(shown, options.tz)}${note} ${coverage}\n`);
      } catch (error) {
        emit.error({
          code: "event_v3_query_failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
}

function coverageLine(
  epochs: ReturnType<typeof scanEventHistoryV3>["epochs"],
  skipped: number,
  timeZone?: string,
): string {
  const first = epochs
    .map((epoch) => epoch.first_at)
    .filter(Boolean)
    .sort()[0];
  const span = first ? ` back to ${localStamp(first, timeZone)}` : "";
  const skippedNote = skipped > 0 ? `; ${skipped} older epochs skipped by --since` : "";
  return `Searched ${epochs.length} epochs${span}${skippedNote}.`;
}

function renderHistoryRows(rows: EventHistoryRowV3[], timeZone?: string): string {
  return renderTable(
    ["TIME", "TYPE", "SESSION", "SUBJECT", "OUTCOME", "MS", "EXIT"],
    rows.map((row) => [
      localStamp(row.recorded_at, timeZone),
      row.event_type,
      row.instance_id?.replace(/^inst_/, "").slice(0, 13) ?? "",
      row.subject ?? "",
      row.outcome ?? "",
      row.duration_ms === null ? "" : String(row.duration_ms),
      row.exit_code === null ? "" : String(row.exit_code),
    ]),
  );
}

function renderEpochs(
  epochs: ReturnType<typeof scanEventHistoryV3>["epochs"],
  timeZone?: string,
): string {
  const table = renderTable(
    ["EPOCH", "FIRST EVENT", "LAST EVENT", "EVENTS", "MB", "MALFORMED"],
    epochs.map((epoch) => [
      epoch.name,
      epoch.first_at ? localStamp(epoch.first_at, timeZone) : "",
      epoch.last_at ? localStamp(epoch.last_at, timeZone) : "",
      String(epoch.events),
      (epoch.bytes / 1_048_576).toFixed(1),
      String(epoch.malformed_lines),
    ]),
  );
  const events = epochs.reduce((total, epoch) => total + epoch.events, 0);
  const bytes = epochs.reduce((total, epoch) => total + epoch.bytes, 0);
  return `${table}${events} events in ${epochs.length} epochs, ${(bytes / 1_048_576).toFixed(1)} MB. The active epoch rotates into the archives by size; search all of them with \`${resolveBinName()} events query\`.\n`;
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
