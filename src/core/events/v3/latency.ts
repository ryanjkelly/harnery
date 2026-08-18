import type { ReadLedgerV3Result } from "./reader.ts";

export const EVENT_V3_LATENCY_PROJECTION_VERSION = "event-v3-latency-v1" as const;

export type LatencyMetricV3 =
  | { state: "observed"; value_ms: number }
  | { state: "unknown"; known_ms: number; reasons: string[] };

export interface ToolLatencyV3 {
  namespace: string;
  name: string;
  count: number;
  duration_ms: LatencyMetricV3;
}

export interface TurnLatencyV3 {
  generation_id: string;
  turn_id: string;
  terminal_event_id: string;
  outcome: string;
  wall_ms: LatencyMetricV3;
  tool_ms: LatencyMetricV3;
  command_ms: LatencyMetricV3;
  command_exclusive_ms: LatencyMetricV3;
  wait_ms: LatencyMetricV3;
  occupied_ms: LatencyMetricV3;
  inference_ms: LatencyMetricV3;
  harness_ms: LatencyMetricV3;
  residual_ms: LatencyMetricV3;
  over_attributed_ms: number;
  context_percent: number | null;
  span_counts: { tool: number; command: number; wait: number };
  tool_breakdown: ToolLatencyV3[];
}

export type LatencyProjectionDiagnosticCodeV3 =
  | "duplicate_turn_terminal"
  | "span_outside_turn"
  | "over_attributed";

export interface LatencyProjectionDiagnosticV3 {
  code: LatencyProjectionDiagnosticCodeV3;
  event_id: string;
}

export interface LatencyProjectionV3 {
  projection_version: typeof EVENT_V3_LATENCY_PROJECTION_VERSION;
  turns: TurnLatencyV3[];
  diagnostics: LatencyProjectionDiagnosticV3[];
}

interface EventShape {
  event_id: string;
  event_type: string;
  scope: { generation_id?: string; turn_id?: string };
  payload: Record<string, unknown>;
}

interface Interval {
  start: number;
  end: number;
  event_id: string;
}

interface IntervalSet {
  intervals: Interval[];
  reasons: string[];
}

export function projectLatencyV3(read: ReadLedgerV3Result): LatencyProjectionV3 {
  if (!read.complete) throw new Error("latency projection requires a complete V3 ledger read");
  const events = read.events.map(({ event }) => event as unknown as EventShape);
  const diagnostics: LatencyProjectionDiagnosticV3[] = [];
  const terminalByTurn = new Map<string, EventShape>();

  for (const event of events) {
    if (event.event_type !== "turn.completed") continue;
    const key = turnKey(event);
    const prior = terminalByTurn.get(key);
    if (prior) diagnostics.push({ code: "duplicate_turn_terminal", event_id: event.event_id });
    else terminalByTurn.set(key, event);
  }

  const turns = [...terminalByTurn.values()].map((terminal) => {
    const key = turnKey(terminal);
    const turnEvents = events.filter((event) => turnKey(event) === key);
    return projectTurn(terminal, turnEvents, diagnostics);
  });
  turns.sort(
    (left, right) =>
      left.generation_id.localeCompare(right.generation_id) ||
      left.turn_id.localeCompare(right.turn_id),
  );
  return { projection_version: EVENT_V3_LATENCY_PROJECTION_VERSION, turns, diagnostics };
}

function projectTurn(
  terminal: EventShape,
  events: EventShape[],
  diagnostics: LatencyProjectionDiagnosticV3[],
): TurnLatencyV3 {
  const span = record(terminal.payload.span);
  const wall = metricFromObservation(span.duration_ms, "turn_duration_unknown");
  const wallInterval = intervalFromSpan(terminal);
  const toolEvents = events.filter(({ event_type }) => event_type === "tool.completed");
  const commandEvents = events.filter(({ event_type }) => event_type === "command.completed");
  const waitEvents = events.filter(({ event_type }) => event_type === "wait.ended");
  const tools = intervalSet(toolEvents, wallInterval, diagnostics);
  const commands = intervalSet(commandEvents, wallInterval, diagnostics);
  const waits = intervalSet(waitEvents, wallInterval, diagnostics);

  const expectedToolCount = observedNumber(terminal.payload.tool_call_count);
  if (expectedToolCount === undefined) tools.reasons.push("tool_call_count_unknown");
  else if (expectedToolCount !== toolEvents.length)
    tools.reasons.push("tool_terminal_count_mismatch");

  const tool = metricFromIntervals(tools);
  const command = metricFromIntervals(commands);
  const wait = metricFromIntervals(waits);
  const commandExclusive = metricFromIntervals({
    intervals: subtractIntervals(commands.intervals, tools.intervals),
    reasons: [...commands.reasons, ...tools.reasons],
  });
  const occupied = metricFromIntervals({
    intervals: [...tools.intervals, ...commands.intervals, ...waits.intervals],
    reasons: [...tools.reasons, ...commands.reasons, ...waits.reasons],
  });
  const inference = metricFromNestedObservation(
    terminal.payload.inference,
    "api_time_ms",
    "inference_timing_unknown",
  );
  const harness = metricFromNestedObservation(
    terminal.payload.harness,
    "hook_time_ms",
    "harness_timing_unknown",
  );
  const residual = residualMetric(wall, occupied, inference, harness);
  const overAttributed = residual.over_attributed_ms;
  if (overAttributed > 0)
    diagnostics.push({ code: "over_attributed", event_id: terminal.event_id });

  const scope = terminal.scope;
  const toolBreakdown = [...groupByTool(toolEvents).entries()]
    .map(([key, groupedEvents]) => {
      const [namespace, name] = key.split("\0");
      return {
        namespace: namespace ?? "",
        name: name ?? "",
        count: groupedEvents.length,
        duration_ms: metricFromIntervals(intervalSet(groupedEvents, wallInterval, diagnostics)),
      };
    })
    .sort(
      (left, right) =>
        left.namespace.localeCompare(right.namespace) || left.name.localeCompare(right.name),
    );
  return {
    generation_id: scope.generation_id ?? "",
    turn_id: scope.turn_id ?? "",
    terminal_event_id: terminal.event_id,
    outcome: string(terminal.payload.outcome),
    wall_ms: wall,
    tool_ms: tool,
    command_ms: command,
    command_exclusive_ms: commandExclusive,
    wait_ms: wait,
    occupied_ms: occupied,
    inference_ms: inference,
    harness_ms: harness,
    residual_ms: residual.metric,
    over_attributed_ms: overAttributed,
    context_percent: latestContextPercent(events),
    span_counts: {
      tool: toolEvents.length,
      command: commandEvents.length,
      wait: waitEvents.length,
    },
    tool_breakdown: toolBreakdown,
  };
}

function groupByTool(events: EventShape[]): Map<string, EventShape[]> {
  const groups = new Map<string, EventShape[]>();
  for (const event of events) {
    const tool = record(event.payload.tool);
    const key = `${string(tool.namespace)}\0${string(tool.name)}`;
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  return groups;
}

function intervalSet(
  events: EventShape[],
  wall: Interval | undefined,
  diagnostics: LatencyProjectionDiagnosticV3[],
): IntervalSet {
  const intervals: Interval[] = [];
  const reasons: string[] = [];
  for (const event of events) {
    const interval = intervalFromSpan(event);
    if (!interval) {
      reasons.push(observationReason(record(event.payload.span).duration_ms));
      continue;
    }
    if (!wall) {
      intervals.push(interval);
      continue;
    }
    if (interval.start < wall.start || interval.end > wall.end) {
      diagnostics.push({ code: "span_outside_turn", event_id: event.event_id });
    }
    const clipped = {
      ...interval,
      start: Math.max(interval.start, wall.start),
      end: Math.min(interval.end, wall.end),
    };
    if (clipped.end > clipped.start) intervals.push(clipped);
  }
  return { intervals, reasons: unique(reasons) };
}

function intervalFromSpan(event: EventShape): Interval | undefined {
  const span = record(event.payload.span);
  const duration = observedNumber(span.duration_ms);
  const start = Date.parse(string(span.opened_at));
  if (duration === undefined || !Number.isFinite(start)) return undefined;
  return { start, end: start + duration, event_id: event.event_id };
}

function metricFromIntervals(set: IntervalSet): LatencyMetricV3 {
  const known = unionLength(set.intervals);
  return set.reasons.length === 0
    ? { state: "observed", value_ms: known }
    : { state: "unknown", known_ms: known, reasons: unique(set.reasons) };
}

function metricFromObservation(value: unknown, fallback: string): LatencyMetricV3 {
  const observed = observedNumber(value);
  return observed === undefined
    ? { state: "unknown", known_ms: 0, reasons: [observationReason(value) || fallback] }
    : { state: "observed", value_ms: observed };
}

function metricFromNestedObservation(
  value: unknown,
  field: string,
  fallback: string,
): LatencyMetricV3 {
  const observation = record(value);
  if (observation.state === "observed") {
    const numberValue = record(observation.value)[field];
    if (typeof numberValue === "number" && numberValue >= 0) {
      return { state: "observed", value_ms: numberValue };
    }
  }
  return {
    state: "unknown",
    known_ms: 0,
    reasons: [observationReason(value) || fallback],
  };
}

function residualMetric(
  wall: LatencyMetricV3,
  occupied: LatencyMetricV3,
  inference: LatencyMetricV3,
  harness: LatencyMetricV3,
): { metric: LatencyMetricV3; over_attributed_ms: number } {
  const components = { wall, occupied, inference, harness };
  const unknown = Object.entries(components)
    .filter(([, metric]) => metric.state === "unknown")
    .map(([name]) => `${name}_unknown`);
  if (unknown.length > 0) {
    return { metric: { state: "unknown", known_ms: 0, reasons: unknown }, over_attributed_ms: 0 };
  }
  const attributed = value(occupied) + value(inference) + value(harness);
  const raw = value(wall) - attributed;
  return {
    metric: { state: "observed", value_ms: Math.max(0, raw) },
    over_attributed_ms: Math.max(0, -raw),
  };
}

function latestContextPercent(events: EventShape[]): number | null {
  const observed = events.filter(({ event_type }) => event_type === "context.observed").at(-1);
  if (!observed) return null;
  const measurement = record(observed.payload.measurement);
  if (measurement.state !== "observed") return null;
  const value = record(measurement.value);
  const used = value.used_tokens;
  const limit = value.limit_tokens;
  return typeof used === "number" && typeof limit === "number" && limit > 0
    ? (used / limit) * 100
    : null;
}

function observedNumber(value: unknown): number | undefined {
  const observation = record(value);
  return observation.state === "observed" &&
    typeof observation.value === "number" &&
    observation.value >= 0
    ? observation.value
    : undefined;
}

function observationReason(value: unknown): string {
  const observation = record(value);
  const state = string(observation.state) || "unknown";
  const reason = string(observation.reason);
  return reason ? `${state}:${reason}` : state;
}

function unionLength(intervals: Interval[]): number {
  const sorted = intervals
    .filter(({ end, start }) => end > start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let start: number | undefined;
  let end: number | undefined;
  for (const interval of sorted) {
    if (start === undefined || end === undefined) {
      start = interval.start;
      end = interval.end;
    } else if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return total + (start !== undefined && end !== undefined ? end - start : 0);
}

function subtractIntervals(source: Interval[], covered: Interval[]): Interval[] {
  const cover = mergeIntervals(covered);
  const output: Interval[] = [];
  for (const interval of mergeIntervals(source)) {
    let pieces = [interval];
    for (const blocker of cover) {
      pieces = pieces.flatMap((piece) => subtractOne(piece, blocker));
    }
    output.push(...pieces);
  }
  return output;
}

function subtractOne(source: Interval, blocker: Interval): Interval[] {
  if (blocker.end <= source.start || blocker.start >= source.end) return [source];
  const output: Interval[] = [];
  if (blocker.start > source.start) output.push({ ...source, end: blocker.start });
  if (blocker.end < source.end) output.push({ ...source, start: blocker.end });
  return output;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const output: Interval[] = [];
  for (const interval of sorted) {
    const prior = output.at(-1);
    if (prior && interval.start <= prior.end) prior.end = Math.max(prior.end, interval.end);
    else output.push({ ...interval });
  }
  return output;
}

function turnKey(event: EventShape): string {
  return `${event.scope.generation_id ?? ""}\0${event.scope.turn_id ?? ""}`;
}

function value(metric: LatencyMetricV3): number {
  return metric.state === "observed" ? metric.value_ms : metric.known_ms;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
