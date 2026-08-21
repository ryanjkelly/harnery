import { ADAPTER_WAIT_KINDS_V3, type AdapterWaitKindV3 } from "./capabilities.ts";
import type { ReadLedgerV3Result } from "./reader.ts";

export const EVENT_V3_LATENCY_PROJECTION_VERSION = "event-v3-latency-v2" as const;

export type LatencyMetricV3 =
  | { state: "observed"; value_ms: number }
  | { state: "unknown"; known_ms: number; upper_bound_ms?: number; reasons: string[] };

export interface ToolLatencyV3 {
  namespace: string;
  name: string;
  count: number;
  duration_ms: LatencyMetricV3;
}

export type ContextCoverageStateV3 =
  | "observed"
  | "partial"
  | "unsupported"
  | "expected_but_missing";

export interface ContextCoverageV3 {
  state: ContextCoverageStateV3;
  event_id: string | null;
  reason: string | null;
}

export interface ResponseLatencyV3 {
  /** Turn start to first tool request, or terminal response for an attested no-tool turn. */
  agent_action_ms: LatencyMetricV3;
  /** Turn start to first tool request; unknown with `no_tool_request` for no-tool turns. */
  first_tool_request_ms: LatencyMetricV3;
  /** Last complete tool terminal to the turn terminal. */
  post_tool_response_ms: LatencyMetricV3;
  /** Turn start to terminal response, only when an attested turn used no tools. */
  no_tool_terminal_response_ms: LatencyMetricV3;
  method: "canonical_event_timestamps_v1";
}

export type WaitKindCompletenessV3 = "complete" | "lower_bound" | "unknown" | "unsupported";

export interface WaitKindCoverageV3 {
  kind: AdapterWaitKindV3;
  started_count: number;
  ended_count: number;
  open_count: number;
  duration_ms: LatencyMetricV3;
  completeness: WaitKindCompletenessV3;
  reason: string | null;
}

export interface TurnLatencyV3 {
  generation_id: string;
  turn_id: string;
  terminal_event_id: string;
  outcome: string;
  wall_ms: LatencyMetricV3;
  tool_ms: LatencyMetricV3;
  tool_bound_coverage_percent: number | null;
  tool_ranking_eligible: boolean;
  command_ms: LatencyMetricV3;
  command_exclusive_ms: LatencyMetricV3;
  wait_ms: LatencyMetricV3;
  occupied_ms: LatencyMetricV3;
  inference_ms: LatencyMetricV3;
  response_latency: ResponseLatencyV3;
  harness_ms: LatencyMetricV3;
  slowest_hook: string | null;
  slowest_hook_ms: number | null;
  residual_ms: LatencyMetricV3;
  over_attributed_ms: number;
  context_percent: number | null;
  context_coverage: ContextCoverageV3;
  wait_coverage_by_kind: Record<AdapterWaitKindV3, WaitKindCoverageV3>;
  span_counts: { tool: number; command: number; wait: number };
  tool_breakdown: ToolLatencyV3[];
}

export type LatencyProjectionDiagnosticCodeV3 =
  | "duplicate_turn_terminal"
  | "tool_channel_unattested"
  | "span_outside_turn"
  | "recovery_bound_exceeds_turn_wall"
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
  time: { observed_at?: string };
  payload: Record<string, unknown>;
}

interface Interval {
  start: number;
  end: number;
  event_id: string;
}

interface IntervalSet {
  intervals: Interval[];
  upperBounds: Interval[];
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
  const waitStartEvents = events.filter(({ event_type }) => event_type === "wait.started");
  const waitEvents = events.filter(({ event_type }) => event_type === "wait.ended");
  const tools = intervalSet(toolEvents, wallInterval, diagnostics);
  const commands = intervalSet(commandEvents, wallInterval, diagnostics);
  const waits = intervalSet(waitEvents, wallInterval, diagnostics);
  const endedWaitIds = new Set(waitEvents.map(({ payload }) => string(record(payload).wait_id)));

  const toolCount = record(terminal.payload.tool_call_count);
  const expectedToolCount = observedNumber(toolCount);
  if (toolCount.state === "unsupported") tools.reasons.push("tool_call_count_unsupported");
  else if (expectedToolCount === undefined) {
    const reason = string(toolCount.reason);
    tools.reasons.push(reason === "tool_channel_unattested" ? reason : "tool_call_count_unknown");
    if (reason === "tool_channel_unattested") {
      diagnostics.push({ code: "tool_channel_unattested", event_id: terminal.event_id });
    }
  } else if (expectedToolCount !== toolEvents.length)
    tools.reasons.push("tool_terminal_count_mismatch");

  const waitCount = record(terminal.payload.wait_count);
  const expectedWaitCount = observedNumber(waitCount);
  if (waitCount.state === "unsupported") waits.reasons.push("wait_count_unsupported");
  else if (expectedWaitCount === undefined) {
    waits.reasons.push(
      Object.keys(waitCount).length === 0 ? "wait_count_unattested" : "wait_count_unknown",
    );
  }
  if (
    waitStartEvents.some(({ payload }) => !endedWaitIds.has(string(record(payload).wait_id))) ||
    (expectedWaitCount !== undefined && expectedWaitCount !== endedWaitIds.size)
  ) {
    waits.reasons.push("wait_terminal_count_mismatch");
  }
  const waitCoverageComplete =
    expectedWaitCount !== undefined &&
    expectedWaitCount === endedWaitIds.size &&
    !waitStartEvents.some(({ payload }) => !endedWaitIds.has(string(record(payload).wait_id)));

  const tool = metricFromIntervals(tools);
  const command = metricFromIntervals(commands);
  const wait = metricFromIntervals(waits);
  const commandExclusive = metricFromIntervals({
    intervals: subtractIntervals(commands.intervals, tools.intervals),
    upperBounds: [...commands.upperBounds, ...tools.upperBounds],
    reasons: [...commands.reasons, ...tools.reasons],
  });
  const occupied = metricFromIntervals({
    intervals: [...tools.intervals, ...commands.intervals, ...waits.intervals],
    upperBounds: [...tools.upperBounds, ...commands.upperBounds, ...waits.upperBounds],
    reasons: [...tools.reasons, ...commands.reasons, ...waits.reasons],
  });
  const inference = metricFromNestedObservation(
    terminal.payload.inference,
    "api_time_ms",
    "inference_timing_unknown",
  );
  const responseLatency = projectResponseLatency(terminal, events, wall, tools, expectedToolCount);
  const harness = metricFromNestedObservation(
    terminal.payload.harness,
    "hook_time_ms",
    "harness_timing_unknown",
  );
  const slowestHook = slowestHookFromObservation(terminal.payload.harness);
  const residual = residualMetric(wall, occupied, inference, harness);
  const overAttributed = residual.over_attributed_ms;
  if (overAttributed > 0)
    diagnostics.push({ code: "over_attributed", event_id: terminal.event_id });

  const scope = terminal.scope;
  const context = latestContext(events);
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
    tool_bound_coverage_percent: boundCoveragePercent(tool, wall),
    tool_ranking_eligible: tool.state === "observed",
    command_ms: command,
    command_exclusive_ms: commandExclusive,
    wait_ms: wait,
    occupied_ms: occupied,
    inference_ms: inference,
    response_latency: responseLatency,
    harness_ms: harness,
    slowest_hook: slowestHook.name,
    slowest_hook_ms: slowestHook.duration_ms,
    residual_ms: residual.metric,
    over_attributed_ms: overAttributed,
    context_percent: context.percent,
    context_coverage: context.coverage,
    wait_coverage_by_kind: projectWaitCoverageByKind(
      waitStartEvents,
      waitEvents,
      wallInterval,
      waitCoverageComplete,
      waitCount,
      diagnostics,
    ),
    span_counts: {
      tool: toolEvents.length,
      command: commandEvents.length,
      wait: waitEvents.length,
    },
    tool_breakdown: toolBreakdown,
  };
}

function projectResponseLatency(
  terminal: EventShape,
  events: EventShape[],
  wall: LatencyMetricV3,
  tools: IntervalSet,
  expectedToolCount: number | undefined,
): ResponseLatencyV3 {
  const turnStart = Date.parse(string(record(terminal.payload.span).opened_at));
  const turnEnd =
    Number.isFinite(turnStart) && wall.state === "observed" ? turnStart + wall.value_ms : undefined;
  const requests = events
    .filter(({ event_type }) => event_type === "tool.requested")
    .map(({ time }) => Date.parse(string(time.observed_at)))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const firstRequest = requests[0];
  const firstTool =
    Number.isFinite(turnStart) && firstRequest !== undefined
      ? observedLatency(firstRequest - turnStart)
      : unknownLatency(expectedToolCount === 0 ? "no_tool_request" : "tool_request_unobserved");
  const noToolTerminal =
    expectedToolCount === 0
      ? wall
      : unknownLatency(
          expectedToolCount === undefined ? "tool_channel_unattested" : "turn_contains_tools",
        );
  const agentAction =
    firstRequest !== undefined
      ? firstTool
      : expectedToolCount === 0
        ? noToolTerminal
        : unknownLatency(
            expectedToolCount === undefined ? "tool_channel_unattested" : "tool_request_unobserved",
          );

  let postTool = unknownLatency(
    expectedToolCount === 0
      ? "no_tool_completion"
      : expectedToolCount === undefined
        ? "tool_channel_unattested"
        : "final_tool_completion_unknown",
  );
  if (
    turnEnd !== undefined &&
    expectedToolCount !== undefined &&
    expectedToolCount > 0 &&
    tools.reasons.length === 0 &&
    tools.intervals.length === expectedToolCount
  ) {
    postTool = observedLatency(turnEnd - Math.max(...tools.intervals.map(({ end }) => end)));
  }

  return {
    agent_action_ms: agentAction,
    first_tool_request_ms: firstTool,
    post_tool_response_ms: postTool,
    no_tool_terminal_response_ms: noToolTerminal,
    method: "canonical_event_timestamps_v1",
  };
}

function projectWaitCoverageByKind(
  starts: EventShape[],
  ends: EventShape[],
  wall: Interval | undefined,
  complete: boolean,
  waitCount: Record<string, unknown>,
  diagnostics: LatencyProjectionDiagnosticV3[],
): Record<AdapterWaitKindV3, WaitKindCoverageV3> {
  const endedIds = new Set(ends.map(({ payload }) => string(record(payload).wait_id)));
  const unsupported = waitCount.state === "unsupported";
  return Object.fromEntries(
    ADAPTER_WAIT_KINDS_V3.map((kind) => {
      const kindStarts = starts.filter(({ payload }) => waitKind(payload) === kind);
      const kindEnds = ends.filter(({ payload }) => waitKind(payload) === kind);
      const openCount = kindStarts.filter(
        ({ payload }) => !endedIds.has(string(record(payload).wait_id)),
      ).length;
      const set = intervalSet(kindEnds, wall, diagnostics);
      if (!complete) set.reasons.push("wait_kind_completeness_unattested");
      const completeness: WaitKindCompletenessV3 = complete
        ? "complete"
        : unsupported
          ? kindStarts.length > 0 || kindEnds.length > 0
            ? "lower_bound"
            : "unsupported"
          : kindStarts.length > 0 || kindEnds.length > 0
            ? "lower_bound"
            : "unknown";
      const reason = complete
        ? null
        : unsupported
          ? "turn_wait_count_unsupported"
          : "turn_wait_count_unattested";
      return [
        kind,
        {
          kind,
          started_count: kindStarts.length,
          ended_count: kindEnds.length,
          open_count: openCount,
          duration_ms: metricFromIntervals(set),
          completeness,
          reason,
        },
      ];
    }),
  ) as Record<AdapterWaitKindV3, WaitKindCoverageV3>;
}

function waitKind(payload: Record<string, unknown>): AdapterWaitKindV3 {
  const value = string(record(payload).kind);
  return ADAPTER_WAIT_KINDS_V3.includes(value as AdapterWaitKindV3)
    ? (value as AdapterWaitKindV3)
    : "unknown";
}

function observedLatency(value: number): LatencyMetricV3 {
  return Number.isFinite(value) && value >= 0
    ? { state: "observed", value_ms: Math.floor(value) }
    : unknownLatency("event_time_order_invalid");
}

function unknownLatency(reason: string): LatencyMetricV3 {
  return { state: "unknown", known_ms: 0, reasons: [reason] };
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
  const upperBounds: Interval[] = [];
  const reasons: string[] = [];
  for (const event of events) {
    const interval = intervalFromSpan(event);
    if (!interval) {
      reasons.push(observationReason(record(event.payload.span).duration_ms));
      const upperBound = upperBoundInterval(event);
      if (upperBound) {
        if (wall && (upperBound.start < wall.start || upperBound.end > wall.end)) {
          diagnostics.push({
            code: "recovery_bound_exceeds_turn_wall",
            event_id: event.event_id,
          });
        }
        const clipped = wall
          ? {
              ...upperBound,
              start: Math.max(upperBound.start, wall.start),
              end: Math.min(upperBound.end, wall.end),
            }
          : upperBound;
        if (clipped.end > clipped.start) upperBounds.push(clipped);
      }
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
  return { intervals, upperBounds, reasons: unique(reasons) };
}

function intervalFromSpan(event: EventShape): Interval | undefined {
  const span = record(event.payload.span);
  const duration = observedNumber(span.duration_ms);
  const start = Date.parse(string(span.opened_at));
  if (duration === undefined || !Number.isFinite(start)) return undefined;
  return { start, end: start + duration, event_id: event.event_id };
}

function upperBoundInterval(event: EventShape): Interval | undefined {
  const span = record(event.payload.span);
  const recovery = record(event.payload.recovery);
  const upperBound = observedNumber(recovery.elapsed_upper_bound_ms);
  const start = Date.parse(string(span.opened_at));
  if (upperBound === undefined || !Number.isFinite(start)) return undefined;
  return { start, end: start + upperBound, event_id: event.event_id };
}

function metricFromIntervals(set: IntervalSet): LatencyMetricV3 {
  const known = unionLength(set.intervals);
  const upperBound = unionLength([...set.intervals, ...set.upperBounds]);
  return set.reasons.length === 0
    ? { state: "observed", value_ms: known }
    : {
        state: "unknown",
        known_ms: known,
        ...(set.upperBounds.length > 0 ? { upper_bound_ms: upperBound } : {}),
        reasons: unique(set.reasons),
      };
}

function boundCoveragePercent(metric: LatencyMetricV3, wall: LatencyMetricV3): number | null {
  if (metric.state !== "unknown" || metric.upper_bound_ms === undefined) return null;
  if (wall.state !== "observed" || wall.value_ms <= 0) return null;
  return Math.round((metric.upper_bound_ms / wall.value_ms) * 1_000) / 10;
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

function latestContext(events: EventShape[]): {
  percent: number | null;
  coverage: ContextCoverageV3;
} {
  const observed = events.filter(({ event_type }) => event_type === "context.observed").at(-1);
  if (!observed) {
    return {
      percent: null,
      coverage: {
        state: "expected_but_missing",
        event_id: null,
        reason: "context_observation_missing",
      },
    };
  }
  const measurement = record(observed.payload.measurement);
  if (measurement.state === "unsupported") {
    return {
      percent: null,
      coverage: {
        state: "unsupported",
        event_id: observed.event_id,
        reason: "context_usage_unsupported",
      },
    };
  }
  if (measurement.state === "expected_but_missing") {
    const reason = string(measurement.reason) || "context_measurement_missing";
    return {
      percent: null,
      coverage: {
        state: reason.startsWith("context_") ? "partial" : "expected_but_missing",
        event_id: observed.event_id,
        reason,
      },
    };
  }
  if (measurement.state !== "observed") {
    return {
      percent: null,
      coverage: {
        state: "expected_but_missing",
        event_id: observed.event_id,
        reason: "context_measurement_invalid",
      },
    };
  }
  const value = record(measurement.value);
  const used = value.used_tokens;
  const limit = value.limit_tokens;
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) {
    return {
      percent: null,
      coverage: {
        state: "expected_but_missing",
        event_id: observed.event_id,
        reason: "context_measurement_invalid",
      },
    };
  }
  return {
    percent: (used / limit) * 100,
    coverage: { state: "observed", event_id: observed.event_id, reason: null },
  };
}

function observedNumber(value: unknown): number | undefined {
  const observation = record(value);
  return observation.state === "observed" &&
    typeof observation.value === "number" &&
    observation.value >= 0
    ? observation.value
    : undefined;
}

function slowestHookFromObservation(value: unknown): {
  name: string | null;
  duration_ms: number | null;
} {
  const observation = record(value);
  if (observation.state !== "observed") return { name: null, duration_ms: null };
  const harness = record(observation.value);
  const name = string(harness.slowest_hook);
  const duration = harness.slowest_hook_ms;
  return name && typeof duration === "number" && Number.isSafeInteger(duration) && duration >= 0
    ? { name, duration_ms: duration }
    : { name: null, duration_ms: null };
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
