import type { HarneryLogLevel, HarneryStorageFamily, HarneryStoragePolicy } from "./contract.ts";

export type HarneryLogScalar = string | number | boolean | null;
export type HarneryLogFieldValue = HarneryLogScalar | readonly HarneryLogScalar[];
export type HarneryLogFields = Record<string, HarneryLogFieldValue>;
export type HarneryLazyFields = HarneryLogFields | (() => HarneryLogFields);
export type HarneryLogContext = Record<string, HarneryLogScalar>;

export interface HarnerySanitizedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: HarnerySanitizedError;
}

export interface HarneryLogRecordV1 {
  schema: "harnery.log-record/v1";
  kind: "record" | "aggregate" | "metrics-generation-reset";
  emitted_at: string;
  family_id: string;
  policy_version: string;
  component_id: string;
  level: HarneryLogLevel;
  event: string;
  writer_id: string;
  writer_seq: number;
  context: HarneryLogContext;
  fields: HarneryLogFields;
  error?: HarnerySanitizedError;
  aggregate?: {
    count: number;
    first_emitted_at: string;
    last_emitted_at: string;
    represented_bytes: number;
    exemplar_digests: readonly string[];
  };
}

export interface OpenTelemetryLogRecord {
  timestamp: string;
  severityText: Uppercase<HarneryLogLevel>;
  body: string;
  attributes: Record<string, HarneryLogFieldValue>;
}

const FIELD_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;
const EVENT = /^[a-z][a-z0-9_.-]{0,127}$/;
const MAX_STRING_CHARS = 4_096;
const MAX_ARRAY_ITEMS = 32;
const MAX_CONTEXT_FIELDS = 24;
const MAX_FIELDS = 64;

export class HarneryLogEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarneryLogEncodingError";
  }
}

export function validateLogEvent(event: string): void {
  if (!EVENT.test(event)) throw new HarneryLogEncodingError(`invalid log event: ${event}`);
}

export function validateLogContext(context: HarneryLogContext): HarneryLogContext {
  if (Object.keys(context).length > MAX_CONTEXT_FIELDS) {
    throw new HarneryLogEncodingError("log context has too many fields");
  }
  const validated: HarneryLogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (!FIELD_KEY.test(key)) throw new HarneryLogEncodingError(`invalid context key: ${key}`);
    if (!isScalar(value)) throw new HarneryLogEncodingError(`invalid context value: ${key}`);
    validated[key] = boundedScalar(value, key);
  }
  return validated;
}

export function validateLogFields(
  fields: HarneryLogFields,
  policy: HarneryStoragePolicy,
): HarneryLogFields {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new HarneryLogEncodingError("log fields must be an object");
  }
  if (Object.keys(fields).length > MAX_FIELDS) {
    throw new HarneryLogEncodingError("log record has too many fields");
  }
  const forbidden = new Set(policy.privacy.forbidden_fields.map((field) => field.toLowerCase()));
  const validated: HarneryLogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_KEY.test(key)) throw new HarneryLogEncodingError(`invalid field key: ${key}`);
    if (forbidden.has(key.toLowerCase())) {
      throw new HarneryLogEncodingError(`private field is forbidden for this family: ${key}`);
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) {
        throw new HarneryLogEncodingError(`field array is too large: ${key}`);
      }
      if (value.some((item) => !isScalar(item))) {
        throw new HarneryLogEncodingError(`field array contains a non-scalar: ${key}`);
      }
      const kinds = new Set(value.filter((item) => item !== null).map((item) => typeof item));
      if (kinds.size > 1) throw new HarneryLogEncodingError(`field array is heterogeneous: ${key}`);
      validated[key] = value.map((item) => boundedScalar(item, key));
    } else if (isScalar(value)) {
      validated[key] = boundedScalar(value, key);
    } else {
      throw new HarneryLogEncodingError(`field is not a scalar or scalar array: ${key}`);
    }
  }
  return validated;
}

export function sanitizeLogError(error: unknown, depth = 0): HarnerySanitizedError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: boundedString(String(error), 1_024) };
  }
  const candidate = error as Error & { code?: unknown; cause?: unknown };
  return {
    name: boundedString(error.name || "Error", 120),
    message: boundedString(error.message, 1_024),
    ...(typeof candidate.code === "string" ? { code: boundedString(candidate.code, 120) } : {}),
    ...(typeof error.stack === "string" ? { stack: boundedString(error.stack, 4_096) } : {}),
    ...(depth < 1 && candidate.cause !== undefined
      ? { cause: sanitizeLogError(candidate.cause, depth + 1) }
      : {}),
  };
}

export function encodeLogRecord(record: HarneryLogRecordV1, family: HarneryStorageFamily): Buffer {
  validateLogRecord(record, family);
  const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const limit = family.policy.records.max_record_bytes.limit;
  if (limit !== null && encoded.byteLength > limit) {
    throw new HarneryLogEncodingError(
      `encoded log record exceeds ${limit} bytes for family ${family.id}`,
    );
  }
  return encoded;
}

export function parseLogRecord(line: string): HarneryLogRecordV1 {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new HarneryLogEncodingError("malformed JSONL record");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HarneryLogEncodingError("log record must be an object");
  }
  const record = value as HarneryLogRecordV1;
  if (record.schema !== "harnery.log-record/v1") {
    throw new HarneryLogEncodingError("unsupported log record schema");
  }
  if (!Number.isSafeInteger(record.writer_seq) || record.writer_seq < 1) {
    throw new HarneryLogEncodingError("invalid writer sequence");
  }
  validateLogEvent(record.event);
  return record;
}

export function toOpenTelemetryLogRecord(record: HarneryLogRecordV1): OpenTelemetryLogRecord {
  return {
    timestamp: record.emitted_at,
    severityText: record.level.toUpperCase() as Uppercase<HarneryLogLevel>,
    body: record.event,
    attributes: {
      "harnery.family_id": record.family_id,
      "harnery.policy_version": record.policy_version,
      "harnery.component_id": record.component_id,
      "harnery.writer_id": record.writer_id,
      "harnery.writer_seq": record.writer_seq,
      ...record.context,
      ...record.fields,
    },
  };
}

function validateLogRecord(record: HarneryLogRecordV1, family: HarneryStorageFamily): void {
  if (record.schema !== "harnery.log-record/v1") {
    throw new HarneryLogEncodingError("unsupported log record schema");
  }
  if (record.family_id !== family.id || record.policy_version !== family.policy.policy_version) {
    throw new HarneryLogEncodingError("log record family or policy identity is invalid");
  }
  if (!Number.isFinite(Date.parse(record.emitted_at))) {
    throw new HarneryLogEncodingError("invalid emission timestamp");
  }
  validateLogEvent(record.event);
  validateLogContext(record.context);
  validateLogFields(record.fields, family.policy);
}

function isScalar(value: unknown): value is HarneryLogScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function boundedScalar(value: HarneryLogScalar, key: string): HarneryLogScalar {
  if (typeof value === "string" && value.length > MAX_STRING_CHARS) {
    throw new HarneryLogEncodingError(`field string is too large: ${key}`);
  }
  return value;
}

function boundedString(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
