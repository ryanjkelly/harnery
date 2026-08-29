export type HarnerySinkEdgeKind = "primary" | "diagnostic" | "fallback";
export type HarnerySinkRecordOrigin = "structured-log" | "raw-process" | "cli-emission";
export type HarneryCapturedStream = "stdout" | "stderr";

export interface HarnerySinkRecord<T = unknown> {
  origin: HarnerySinkRecordOrigin;
  payload: T;
}

export interface HarnerySinkDelivery<T = unknown> extends HarnerySinkRecord<T> {
  entry_sink_id: string;
  sink_id: string;
  route: "entry" | HarnerySinkEdgeKind;
  source_sink_id?: string;
}

export interface HarnerySink {
  id: string;
  deliver(delivery: HarnerySinkDelivery): void | Promise<void>;
  emits_stream?: HarneryCapturedStream;
  captures?: {
    origin: HarneryCapturedStream | "cli-emission";
    origin_sink_id?: string;
  };
}

export interface HarnerySinkEdge {
  from: string;
  to: string;
  kind: HarnerySinkEdgeKind;
}

export type HarnerySinkGraphErrorCode =
  | "duplicate_sink"
  | "invalid_sink"
  | "unknown_sink"
  | "duplicate_edge"
  | "self_edge"
  | "cycle"
  | "cli_emission_capture"
  | "capture_origin_invalid"
  | "capture_loop"
  | "fanout_limit"
  | "graph_limit";

export class HarnerySinkGraphError extends Error {
  constructor(
    readonly code: HarnerySinkGraphErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HarnerySinkGraphError";
  }
}

export type HarnerySinkDeliveryFailureCode = "sink_delivery_failed" | "delivery_budget_exhausted";

export class HarnerySinkDeliveryError extends Error {
  constructor(
    readonly code: HarnerySinkDeliveryFailureCode,
    readonly sink_id: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "HarnerySinkDeliveryError";
  }
}

export interface HarnerySinkDeliveryFailure {
  code: HarnerySinkDeliveryFailureCode;
  sink_id: string;
  route: HarnerySinkDelivery["route"];
  error: HarnerySinkDeliveryError;
}

export interface HarnerySinkDeliveryResult {
  attempted: number;
  delivered: readonly string[];
  failures: readonly HarnerySinkDeliveryFailure[];
  truncated: boolean;
}

export interface HarnerySinkGraphOptions {
  max_sinks?: number;
  max_edges?: number;
  max_fanout?: number;
  max_deliveries?: number;
}

interface QueuedDelivery {
  sink_id: string;
  route: HarnerySinkDelivery["route"];
  source_sink_id?: string;
  record: HarnerySinkRecord;
}

const ID = /^[a-z][a-z0-9._-]{0,63}$/;

export class HarnerySinkGraph {
  readonly sinks: readonly Readonly<HarnerySink>[];
  readonly edges: readonly Readonly<HarnerySinkEdge>[];
  readonly #byId: ReadonlyMap<string, Readonly<HarnerySink>>;
  readonly #outgoing: ReadonlyMap<string, readonly Readonly<HarnerySinkEdge>[]>;
  readonly #maxDeliveries: number;

  constructor(
    sinks: readonly HarnerySink[],
    edges: readonly HarnerySinkEdge[],
    options: HarnerySinkGraphOptions = {},
  ) {
    const limits = {
      max_sinks: positive(options.max_sinks ?? 32, "max_sinks"),
      max_edges: positive(options.max_edges ?? 128, "max_edges"),
      max_fanout: positive(options.max_fanout ?? 8, "max_fanout"),
      max_deliveries: positive(options.max_deliveries ?? 64, "max_deliveries"),
    };
    if (sinks.length > limits.max_sinks || edges.length > limits.max_edges) {
      throw new HarnerySinkGraphError("graph_limit", "sink graph exceeds its construction limit");
    }
    const sinkCopies = sinks.map((sink) => Object.freeze({ ...sink }));
    const byId = new Map<string, Readonly<HarnerySink>>();
    for (const sink of sinkCopies) {
      if (!ID.test(sink.id) || typeof sink.deliver !== "function") {
        throw new HarnerySinkGraphError("invalid_sink", `invalid sink: ${sink.id}`);
      }
      if (byId.has(sink.id)) {
        throw new HarnerySinkGraphError("duplicate_sink", `duplicate sink: ${sink.id}`);
      }
      if (sink.captures?.origin === "cli-emission") {
        throw new HarnerySinkGraphError(
          "cli_emission_capture",
          `sink ${sink.id} cannot capture CLI emission`,
        );
      }
      byId.set(sink.id, sink);
    }
    const edgeCopies = edges.map((edge) => Object.freeze({ ...edge }));
    const outgoing = new Map<string, readonly Readonly<HarnerySinkEdge>[]>();
    const edgeKeys = new Set<string>();
    for (const edge of edgeCopies) {
      if (!byId.has(edge.from) || !byId.has(edge.to)) {
        throw new HarnerySinkGraphError(
          "unknown_sink",
          `sink edge references an unknown sink: ${edge.from}->${edge.to}`,
        );
      }
      if (edge.from === edge.to) {
        throw new HarnerySinkGraphError(
          "self_edge",
          `sink ${edge.from} cannot route ${edge.kind} delivery through itself`,
        );
      }
      if (!new Set<HarnerySinkEdgeKind>(["primary", "diagnostic", "fallback"]).has(edge.kind)) {
        throw new HarnerySinkGraphError("invalid_sink", `invalid sink edge kind: ${edge.kind}`);
      }
      const key = `${edge.from}\0${edge.to}\0${edge.kind}`;
      if (edgeKeys.has(key)) {
        throw new HarnerySinkGraphError(
          "duplicate_edge",
          `duplicate sink edge: ${edge.from}->${edge.to}`,
        );
      }
      edgeKeys.add(key);
      const next = [...(outgoing.get(edge.from) ?? []), edge];
      if (next.length > limits.max_fanout) {
        throw new HarnerySinkGraphError("fanout_limit", `sink ${edge.from} exceeds fan-out limit`);
      }
      outgoing.set(edge.from, Object.freeze(next));
    }
    rejectCycles(byId, outgoing);
    rejectCaptureLoops(byId, outgoing);
    this.sinks = Object.freeze(sinkCopies);
    this.edges = Object.freeze(edgeCopies);
    this.#byId = byId;
    this.#outgoing = outgoing;
    this.#maxDeliveries = limits.max_deliveries;
    Object.freeze(this);
  }

  async deliver(
    entrySinkId: string,
    record: HarnerySinkRecord,
  ): Promise<HarnerySinkDeliveryResult> {
    if (!this.#byId.has(entrySinkId)) {
      throw new HarnerySinkGraphError("unknown_sink", `unknown entry sink: ${entrySinkId}`);
    }
    if (record.origin === "cli-emission") {
      throw new HarnerySinkGraphError(
        "cli_emission_capture",
        "CLI emission is not a structured sink record",
      );
    }
    const queue: QueuedDelivery[] = [{ sink_id: entrySinkId, route: "entry", record }];
    const visited = new Set<string>();
    const delivered: string[] = [];
    const failures: HarnerySinkDeliveryFailure[] = [];
    let attempted = 0;
    let truncated = false;
    while (queue.length > 0) {
      const next = queue.shift()!;
      const visitKey = `${next.sink_id}\0${next.route}`;
      if (visited.has(visitKey)) continue;
      if (attempted >= this.#maxDeliveries) {
        truncated = true;
        failures.push(deliveryFailure("delivery_budget_exhausted", next, undefined));
        break;
      }
      visited.add(visitKey);
      attempted += 1;
      const sink = this.#byId.get(next.sink_id)!;
      try {
        await sink.deliver({
          ...next.record,
          entry_sink_id: entrySinkId,
          sink_id: next.sink_id,
          route: next.route,
          ...(next.source_sink_id ? { source_sink_id: next.source_sink_id } : {}),
        });
        delivered.push(next.sink_id);
        if (next.route === "entry" || next.route === "primary") {
          enqueueEdges(queue, this.#outgoing.get(next.sink_id), "primary", next.record);
        }
      } catch (error) {
        const failure = deliveryFailure("sink_delivery_failed", next, error);
        failures.push(failure);
        // Recovery lanes are terminal. Their failures remain typed return data
        // and never emit another diagnostic through this graph.
        if (next.route === "entry" || next.route === "primary") {
          enqueueEdges(queue, this.#outgoing.get(next.sink_id), "diagnostic", {
            origin: "structured-log",
            payload: failure,
          });
          enqueueEdges(queue, this.#outgoing.get(next.sink_id), "fallback", next.record);
        }
      }
    }
    return Object.freeze({
      attempted,
      delivered: Object.freeze(delivered),
      failures: Object.freeze(failures),
      truncated,
    });
  }
}

function enqueueEdges(
  queue: QueuedDelivery[],
  edges: readonly Readonly<HarnerySinkEdge>[] | undefined,
  kind: HarnerySinkEdgeKind,
  record: HarnerySinkRecord,
): void {
  for (const edge of edges ?? []) {
    if (edge.kind !== kind) continue;
    queue.push({ sink_id: edge.to, route: kind, source_sink_id: edge.from, record });
  }
}

function deliveryFailure(
  code: HarnerySinkDeliveryFailureCode,
  delivery: QueuedDelivery,
  cause: unknown,
): HarnerySinkDeliveryFailure {
  const error = new HarnerySinkDeliveryError(
    code,
    delivery.sink_id,
    code === "sink_delivery_failed"
      ? `sink delivery failed: ${delivery.sink_id}`
      : `sink delivery budget exhausted before ${delivery.sink_id}`,
    cause,
  );
  return Object.freeze({ code, sink_id: delivery.sink_id, route: delivery.route, error });
}

function rejectCycles(
  sinks: ReadonlyMap<string, Readonly<HarnerySink>>,
  outgoing: ReadonlyMap<string, readonly Readonly<HarnerySinkEdge>[]>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new HarnerySinkGraphError("cycle", `sink graph cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const edge of outgoing.get(id) ?? []) visit(edge.to);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of sinks.keys()) visit(id);
}

function rejectCaptureLoops(
  sinks: ReadonlyMap<string, Readonly<HarnerySink>>,
  outgoing: ReadonlyMap<string, readonly Readonly<HarnerySinkEdge>[]>,
): void {
  for (const sink of sinks.values()) {
    const capture = sink.captures;
    if (!capture || capture.origin === "cli-emission") continue;
    if (!capture.origin_sink_id) {
      throw new HarnerySinkGraphError(
        "capture_origin_invalid",
        `capturing sink ${sink.id} must name its origin sink`,
      );
    }
    const origin = sinks.get(capture.origin_sink_id);
    if (!origin || origin.emits_stream !== capture.origin) {
      throw new HarnerySinkGraphError(
        "capture_origin_invalid",
        `capturing sink ${sink.id} has an invalid ${capture.origin} origin`,
      );
    }
    if (sink.id === origin.id || reachable(sink.id, origin.id, outgoing)) {
      throw new HarnerySinkGraphError(
        "capture_loop",
        `captured ${capture.origin} from ${origin.id} routes back through ${sink.id}`,
      );
    }
  }
}

function reachable(
  from: string,
  target: string,
  outgoing: ReadonlyMap<string, readonly Readonly<HarnerySinkEdge>[]>,
): boolean {
  const pending = [from];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of outgoing.get(current) ?? []) pending.push(edge.to);
  }
  return false;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HarnerySinkGraphError("graph_limit", `${name} must be a positive safe integer`);
  }
  return value;
}
