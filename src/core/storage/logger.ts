import { randomBytes } from "node:crypto";
import { BoundedLogBuffer } from "./buffer.ts";
import { createStorageCatalog, type HarneryStorageCatalog } from "./catalog.ts";
import type {
  HarneryLoggerBinding,
  HarneryLogLevel,
  HarneryRegisteredStorageFamily,
} from "./contract.ts";
import {
  encodeLogRecord,
  type HarneryLazyFields,
  type HarneryLogContext,
  type HarneryLogFields,
  type HarneryLogRecordV1,
  type HarneryLogScalar,
  sanitizeLogError,
  validateLogContext,
  validateLogEvent,
  validateLogFields,
} from "./jsonl.ts";
import { LogMetricsAccumulator } from "./metrics.ts";
import { FileSegmentSink, familyLogDirectory } from "./segments.ts";
import { ProcessStormController } from "./storm-control.ts";

export interface HarneryLogger {
  isEnabled(level: HarneryLogLevel): boolean;
  child(context: HarneryLogContext): HarneryLogger;
  trace(event: string, fields?: HarneryLazyFields, error?: unknown): void;
  debug(event: string, fields?: HarneryLazyFields, error?: unknown): void;
  info(event: string, fields?: HarneryLazyFields, error?: unknown): void;
  warn(event: string, fields?: HarneryLazyFields, error?: unknown): void;
  error(event: string, fields?: HarneryLazyFields, error?: unknown): void;
  fatal(event: string, fields?: HarneryLazyFields, error?: unknown): void;
  flush(options?: { durability?: "memory" | "disk" }): Promise<void>;
  close(): Promise<void>;
}

export interface HarneryLoggerRuntime {
  logger(componentId: string, context?: HarneryLogContext): HarneryLogger;
  flush(options?: { durability?: "memory" | "disk" }): Promise<void>;
  close(): Promise<void>;
}

export interface HarneryLogLevelConfig {
  default?: HarneryLogLevel;
  families?: Readonly<Record<string, HarneryLogLevel>>;
  components?: Readonly<Record<string, HarneryLogLevel>>;
}

export class HarneryUnsupportedDurabilityError extends Error {
  constructor(readonly familyId: string) {
    super(`family ${familyId} does not support durable disk flush`);
    this.name = "HarneryUnsupportedDurabilityError";
  }
}

interface QueuedRecord {
  record: HarneryLogRecordV1;
  encoded: Buffer;
}
interface FamilyPipeline {
  family: HarneryRegisteredStorageFamily;
  buffer: BoundedLogBuffer<QueuedRecord>;
  metrics: LogMetricsAccumulator;
  storm: ProcessStormController;
  durableNextFlush: boolean;
}

const LEVELS: readonly HarneryLogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

export function createFileLoggerRuntime(options: {
  catalog: HarneryStorageCatalog;
  bindings?: readonly HarneryLoggerBinding[];
  level_config?: HarneryLogLevelConfig;
  env?: NodeJS.ProcessEnv;
  strict_levels?: boolean;
}): HarneryLoggerRuntime {
  return new LoggerRuntime(
    options.catalog,
    options.bindings ?? options.catalog.logger_bindings,
    options.level_config,
    options.env,
    options.strict_levels,
  );
}

export function createInMemoryLoggerRuntime(options: {
  catalog: HarneryStorageCatalog;
  bindings: readonly HarneryLoggerBinding[];
  records?: HarneryLogRecordV1[];
  level_config?: HarneryLogLevelConfig;
  env?: NodeJS.ProcessEnv;
}): HarneryLoggerRuntime & { records: HarneryLogRecordV1[] } {
  const records = options.records ?? [];
  const runtime = new LoggerRuntime(
    options.catalog,
    options.bindings,
    options.level_config,
    options.env ?? {},
    false,
    async (items) => {
      records.push(...items.map((item) => item.record));
    },
  );
  return Object.assign(runtime, { records });
}

export function createNullLoggerRuntime(): HarneryLoggerRuntime {
  const logger: HarneryLogger = {
    isEnabled: () => false,
    child: () => logger,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    async flush() {},
    async close() {},
  };
  return { logger: () => logger, async flush() {}, async close() {} };
}

class LoggerRuntime implements HarneryLoggerRuntime {
  readonly #catalog: HarneryStorageCatalog;
  readonly #bindings: Map<string, string>;
  readonly #pipelines = new Map<string, FamilyPipeline>();
  readonly #writerId = `${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}`;
  readonly #levels: HarneryLogLevelConfig;
  readonly #env: NodeJS.ProcessEnv;
  readonly #strict: boolean;
  readonly #drainOverride?: (items: readonly QueuedRecord[]) => Promise<void>;
  #writerSeq = 0;
  #closed = false;

  constructor(
    catalog: HarneryStorageCatalog,
    bindings: readonly HarneryLoggerBinding[],
    levels?: HarneryLogLevelConfig,
    env: NodeJS.ProcessEnv = process.env,
    strict = true,
    drainOverride?: (items: readonly QueuedRecord[]) => Promise<void>,
  ) {
    this.#catalog = catalog;
    this.#bindings = new Map(bindings.map((binding) => [binding.component_id, binding.family_id]));
    this.#levels = levels ?? {};
    this.#env = env;
    this.#strict = strict;
    this.#drainOverride = drainOverride;
    for (const familyId of this.#bindings.values()) this.#pipeline(this.#catalog.require(familyId));
  }

  logger(componentId: string, context: HarneryLogContext = {}): HarneryLogger {
    const familyId = this.#bindings.get(componentId);
    if (!familyId) throw new Error(`unknown logger binding: ${componentId}`);
    const family = this.#catalog.require(familyId);
    return new BoundLogger(this, componentId, family, validateLogContext(context));
  }

  async flush(options: { durability?: "memory" | "disk" } = {}): Promise<void> {
    const pipelines = [...this.#pipelines.values()];
    if (options.durability === "disk") {
      for (const pipeline of pipelines) {
        if (pipeline.family.durability === "best-effort")
          throw new HarneryUnsupportedDurabilityError(pipeline.family.id);
        pipeline.durableNextFlush = true;
      }
    }
    for (const pipeline of pipelines) this.#emitStormSummaries(pipeline);
    await Promise.all(pipelines.map((pipeline) => pipeline.buffer.flush()));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pipeline of this.#pipelines.values()) this.#emitStormSummaries(pipeline);
    await Promise.all([...this.#pipelines.values()].map((pipeline) => pipeline.buffer.close()));
  }

  enabled(
    componentId: string,
    family: HarneryRegisteredStorageFamily,
    level: HarneryLogLevel,
  ): boolean {
    if (family.policy.writes !== "active" || this.#closed) return false;
    const minimum = resolveLogLevel({
      component_id: componentId,
      family,
      config: this.#levels,
      env: this.#env,
      strict: this.#strict,
    });
    return LEVELS.indexOf(level) >= LEVELS.indexOf(minimum);
  }

  emit(
    componentId: string,
    family: HarneryRegisteredStorageFamily,
    context: HarneryLogContext,
    level: HarneryLogLevel,
    event: string,
    lazy: HarneryLazyFields = {},
    error?: unknown,
  ): void {
    if (!this.enabled(componentId, family, level)) return;
    const pipeline = this.#pipeline(family);
    try {
      validateLogEvent(event);
      const fields = validateLogFields(typeof lazy === "function" ? lazy() : lazy, family.policy);
      const record: HarneryLogRecordV1 = {
        schema: "harnery.log-record/v1",
        kind: "record",
        emitted_at: new Date().toISOString(),
        family_id: family.id,
        policy_version: family.policy.policy_version,
        component_id: componentId,
        level,
        event,
        writer_id: this.#writerId,
        writer_seq: ++this.#writerSeq,
        context,
        fields,
        ...(error === undefined ? {} : { error: sanitizeLogError(error) }),
      };
      const encoded = encodeLogRecord(record, family);
      pipeline.metrics.increment("accepted");
      pipeline.metrics.increment("encoded");
      pipeline.metrics.increment("bytes_accepted", encoded.byteLength);
      if (!pipeline.storm.admit(`${componentId}:${event}`, level, encoded.byteLength)) {
        pipeline.metrics.increment("sampled");
        return;
      }
      pipeline.buffer.enqueue({
        value: { record, encoded },
        bytes: encoded.byteLength,
        high_priority: level === "error" || level === "fatal",
      });
    } catch {
      pipeline.metrics.failure("encoding");
    }
  }

  #pipeline(family: HarneryRegisteredStorageFamily): FamilyPipeline {
    const current = this.#pipelines.get(family.id);
    if (current) return current;
    const metrics = new LogMetricsAccumulator();
    const sink = this.#drainOverride
      ? undefined
      : new FileSegmentSink({ directory: familyLogDirectory(family), family });
    const pipeline = {} as FamilyPipeline;
    pipeline.family = family;
    pipeline.metrics = metrics;
    pipeline.durableNextFlush = false;
    pipeline.storm = new ProcessStormController({
      enabled: family.storm_policy?.enabled ?? true,
      window_ms: family.storm_policy?.window_ms ?? 1_000,
      max_exemplars: family.storm_policy?.max_exemplars ?? 3,
    });
    const policy = family.buffer_policy ?? {
      max_bytes: 1024 * 1024,
      max_records: 2_000,
      flush_interval_ms: 250,
      high_severity_reserve_bytes: 128 * 1024,
    };
    pipeline.buffer = new BoundedLogBuffer({
      ...policy,
      minimum_high_priority_drain_interval_ms: 25,
      on_drop: (_reason, item) => {
        metrics.increment("dropped");
        metrics.increment("bytes_dropped", item.encoded.byteLength);
      },
      on_drain_error: () => metrics.failure("sink"),
      drain: async (items) => {
        const started = Date.now();
        try {
          if (this.#drainOverride) await this.#drainOverride(items.map((item) => item.value));
          else
            await sink!.append(
              items.map((item) => item.value.encoded),
              metrics.take(),
              pipeline.durableNextFlush,
            );
        } finally {
          pipeline.durableNextFlush = false;
          metrics.observeLatency("flush_latency_ms", Date.now() - started);
        }
      },
    });
    this.#pipelines.set(family.id, pipeline);
    return pipeline;
  }

  #emitStormSummaries(pipeline: FamilyPipeline): void {
    for (const summary of pipeline.storm.drainSummaries(true)) {
      const record: HarneryLogRecordV1 = {
        schema: "harnery.log-record/v1",
        kind: "aggregate",
        emitted_at: summary.last_emitted_at,
        family_id: pipeline.family.id,
        policy_version: pipeline.family.policy.policy_version,
        component_id: "harnery.logger",
        level: "warn",
        event: "log.storm_aggregate",
        writer_id: this.#writerId,
        writer_seq: ++this.#writerSeq,
        context: {},
        fields: { key: summary.key },
        aggregate: {
          count: summary.count,
          represented_bytes: summary.represented_bytes,
          first_emitted_at: summary.first_emitted_at,
          last_emitted_at: summary.last_emitted_at,
          exemplar_digests: summary.exemplar_digests,
        },
      };
      const encoded = encodeLogRecord(record, pipeline.family);
      pipeline.buffer.enqueue({
        value: { record, encoded },
        bytes: encoded.byteLength,
        high_priority: true,
      });
      pipeline.metrics.increment("coalesced", summary.count);
    }
  }
}

class BoundLogger implements HarneryLogger {
  constructor(
    readonly runtime: LoggerRuntime,
    readonly componentId: string,
    readonly family: HarneryRegisteredStorageFamily,
    readonly context: HarneryLogContext,
  ) {}
  isEnabled(level: HarneryLogLevel): boolean {
    return this.runtime.enabled(this.componentId, this.family, level);
  }
  child(context: HarneryLogContext): HarneryLogger {
    return new BoundLogger(
      this.runtime,
      this.componentId,
      this.family,
      validateLogContext({ ...this.context, ...context }),
    );
  }
  trace(e: string, f?: HarneryLazyFields, x?: unknown): void {
    this.runtime.emit(this.componentId, this.family, this.context, "trace", e, f, x);
  }
  debug(e: string, f?: HarneryLazyFields, x?: unknown): void {
    this.runtime.emit(this.componentId, this.family, this.context, "debug", e, f, x);
  }
  info(e: string, f?: HarneryLazyFields, x?: unknown): void {
    this.runtime.emit(this.componentId, this.family, this.context, "info", e, f, x);
  }
  warn(e: string, f?: HarneryLazyFields, x?: unknown): void {
    this.runtime.emit(this.componentId, this.family, this.context, "warn", e, f, x);
  }
  error(e: string, f?: HarneryLazyFields, x?: unknown): void {
    this.runtime.emit(this.componentId, this.family, this.context, "error", e, f, x);
  }
  fatal(e: string, f?: HarneryLazyFields, x?: unknown): void {
    this.runtime.emit(this.componentId, this.family, this.context, "fatal", e, f, x);
  }
  flush(o?: { durability?: "memory" | "disk" }): Promise<void> {
    return this.runtime.flush(o);
  }
  close(): Promise<void> {
    return this.runtime.close();
  }
}

export function resolveLogLevel(options: {
  component_id: string;
  family: HarneryRegisteredStorageFamily;
  config?: HarneryLogLevelConfig;
  env?: NodeJS.ProcessEnv;
  strict?: boolean;
}): HarneryLogLevel {
  const env = options.env ?? process.env;
  const strict = options.strict ?? true;
  const scoped = parseScopedLevels(env.HARNERY_LOG_LEVELS, strict);
  const raw =
    scoped.components[options.component_id] ??
    scoped.families[options.family.id] ??
    options.config?.components?.[options.component_id] ??
    options.config?.families?.[options.family.id] ??
    env.HARNERY_LOG_LEVEL ??
    options.config?.default ??
    options.family.default_level ??
    "info";
  if (isLevel(raw)) return raw;
  if (strict) throw new Error(`invalid Harnery log level: ${raw}`);
  return options.family.default_level ?? "info";
}

function parseScopedLevels(
  raw: string | undefined,
  strict: boolean,
): { components: Record<string, HarneryLogLevel>; families: Record<string, HarneryLogLevel> } {
  const result = {
    components: {} as Record<string, HarneryLogLevel>,
    families: {} as Record<string, HarneryLogLevel>,
  };
  if (!raw) return result;
  for (const token of raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [scope, value] = token.split("=", 2);
    const [kind, id] = (scope ?? "").split(":", 2);
    if (!id || !isLevel(value)) {
      if (strict) throw new Error(`invalid HARNERY_LOG_LEVELS entry: ${token}`);
      continue;
    }
    if (kind === "component") result.components[id] = value;
    else if (kind === "family") result.families[id] = value;
    else if (strict) throw new Error(`invalid HARNERY_LOG_LEVELS scope: ${token}`);
  }
  return result;
}

function isLevel(value: unknown): value is HarneryLogLevel {
  return typeof value === "string" && LEVELS.includes(value as HarneryLogLevel);
}

export function legacyLogFields(value: Record<string, unknown>): HarneryLogFields {
  const out: HarneryLogFields = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate === undefined) continue;
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "number" ||
      typeof candidate === "boolean"
    )
      out[key] = candidate as HarneryLogScalar;
    else if (
      Array.isArray(candidate) &&
      candidate.every(
        (item) => item === null || ["string", "number", "boolean"].includes(typeof item),
      )
    )
      out[key] = candidate as HarneryLogScalar[];
    else out[key] = JSON.stringify(candidate).slice(0, 4_096);
  }
  return out;
}

const PROCESS_RUNTIMES = new Map<string, HarneryLoggerRuntime>();
export function processLogger(
  coordRoot: string,
  componentId: "agent-hook" | "agent-coord",
): HarneryLogger {
  let runtime = PROCESS_RUNTIMES.get(coordRoot);
  if (!runtime) {
    const bindings = [
      { component_id: "agent-hook", family_id: "agent-hook-debug-log" },
      { component_id: "agent-coord", family_id: "agent-coord-debug-log" },
    ] as const;
    const catalog = createStorageCatalog({ coord_root: coordRoot }, { logger_bindings: bindings });
    runtime = createFileLoggerRuntime({ catalog, bindings, strict_levels: false });
    PROCESS_RUNTIMES.set(coordRoot, runtime);
  }
  return runtime.logger(componentId);
}
export async function closeProcessLoggers(): Promise<void> {
  await Promise.all([...PROCESS_RUNTIMES.values()].map((runtime) => runtime.close()));
  PROCESS_RUNTIMES.clear();
}
