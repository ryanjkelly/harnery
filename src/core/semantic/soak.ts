import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

import { coordEnv } from "../../lib/env.ts";
import { createStorageCatalog } from "../storage/catalog.ts";
import type { HarneryLogRecordV1 } from "../storage/jsonl.ts";
import { parseLogRecord } from "../storage/jsonl.ts";
import { familyLogDirectory, readSegmentManifest } from "../storage/segments.ts";
import {
  SEMANTIC_CONFIGURED_MODELS,
  SEMANTIC_EXPRESSION_CUES,
  SEMANTIC_HARNESSES,
  SEMANTIC_PHASES,
  type SemanticConfidence,
  type SemanticConfiguredModel,
  type SemanticExpressionCue,
  type SemanticHarness,
  type SemanticPhase,
} from "./contract.ts";
import type { SemanticOnceOutcome } from "./once.ts";
import { readSemanticServiceStatus } from "./service-status.ts";
import { readSemanticAgentDocument, semanticPaths } from "./storage.ts";
import {
  emptySemanticUsageAggregate,
  mergeSemanticUsageAggregates,
  type SemanticUsageAggregate,
} from "./usage.ts";

export const SEMANTIC_SOAK_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_SOAK_DEFAULT_MINUTES = 60;
export const SEMANTIC_SOAK_REVERSAL_WINDOW_MS = 10 * 60_000;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOG_RECORDS = 10_000;
const SUBJECT_DIGEST_LENGTH = 16;

export interface SemanticSoakReadingV1 {
  subject_id: string;
  generated_at: string;
  source_harness: SemanticHarness;
  configured_model: SemanticConfiguredModel;
  resolved_model_id?: string;
  model_attestation?: "verified" | "requested-only";
  origin: "model-call" | "cache";
  phase: SemanticPhase;
  phase_confidence: SemanticConfidence;
  expression_cue?: SemanticExpressionCue;
  expression_confidence?: SemanticConfidence;
}

export interface SemanticSoakReportV1 {
  schema_version: typeof SEMANTIC_SOAK_SCHEMA_VERSION;
  generated_at: string;
  window: {
    requested_minutes: number;
    requested_start_at: string;
    ended_at: string;
    available_from?: string;
    available_through?: string;
    window_complete: boolean;
  };
  service: {
    running: boolean;
    stale: boolean;
  };
  coverage: {
    pass_count: number;
    instrumented_pass_count: number;
    legacy_pass_count: number;
    accepted_reading_count: number;
    cached_reading_count: number;
  };
  outcomes: SemanticUsageAggregate["outcomes"];
  usage: SemanticUsageAggregate;
  readings: {
    phase_counts: Partial<Record<SemanticPhase, number>>;
    expression_counts: Partial<Record<SemanticExpressionCue | "abstained", number>>;
    expression_confidence_counts: Partial<Record<SemanticConfidence, number>>;
    by_harness: Partial<Record<SemanticHarness, number>>;
  };
  stability: {
    subject_count: number;
    subjects_with_repeat_observations: number;
    adjacent_comparisons: number;
    unchanged_cues: number;
    cue_changes: number;
    rapid_reversals: number;
    stable_repeat_rate?: number;
    transitions: Array<{
      from: SemanticExpressionCue | "abstained";
      to: SemanticExpressionCue | "abstained";
      count: number;
    }>;
  };
  limitations: string[];
}

interface SemanticServiceLogEntry {
  ts: string;
  event: string;
  model_calls?: number;
  cache_hits?: number;
  usage?: SemanticUsageAggregate;
  semantic_readings?: SemanticSoakReadingV1[];
  semantic_readings_truncated?: boolean;
  semantic_readings_omitted?: number;
}

interface TimedReading {
  captured_at: string;
  reading: SemanticSoakReadingV1;
}

/**
 * Project accepted pass outcomes into bounded log tokens. No task text, model
 * prose, event IDs, instance IDs, or generation IDs cross this boundary.
 */
export function semanticSoakReadings(
  coordRootRaw: string,
  outcomes: readonly SemanticOnceOutcome[],
): SemanticSoakReadingV1[] {
  const coordRoot = resolve(coordRootRaw);
  return outcomes.flatMap((outcome) => {
    if (outcome.action !== "accepted" && outcome.action !== "cached") return [];
    const document = readSemanticAgentDocument(coordRoot, outcome.generation_id);
    if (document?.reader_outcome !== "accepted") return [];
    const cue = document.meaning.expression_cue;
    return [
      {
        subject_id: semanticSubjectId(outcome.generation_id),
        generated_at: document.generated_at,
        source_harness: document.reader.harness,
        configured_model: document.reader.configured_model,
        ...(document.reader.resolved_model_id
          ? { resolved_model_id: document.reader.resolved_model_id }
          : {}),
        ...(document.reader.model_attestation
          ? { model_attestation: document.reader.model_attestation }
          : {}),
        origin: outcome.action === "cached" ? "cache" : "model-call",
        phase: document.meaning.phase.value,
        phase_confidence: document.meaning.phase.confidence,
        ...(cue
          ? {
              expression_cue: cue.value,
              expression_confidence: cue.confidence,
            }
          : {}),
      },
    ];
  });
}

export function readSemanticSoakReport(
  coordRootRaw: string,
  options: { minutes?: number; now?: Date } = {},
): SemanticSoakReportV1 {
  const coordRoot = resolve(coordRootRaw);
  const minutes = positiveMinutes(options.minutes ?? SEMANTIC_SOAK_DEFAULT_MINUTES);
  const now = options.now ?? new Date();
  const endedAt = now.toISOString();
  const requestedStart = new Date(now.getTime() - minutes * 60_000).toISOString();
  const entries = readSemanticServiceLog(coordRoot);
  const timestamped = entries.filter((entry) => validTimestamp(entry.ts));
  const passEntries = timestamped.filter(
    (entry) => entry.event === "pass" && entry.ts >= requestedStart && entry.ts <= endedAt,
  );
  const usage = passEntries.reduce(
    (total, entry) =>
      isSemanticUsageAggregate(entry.usage)
        ? mergeSemanticUsageAggregates(total, entry.usage)
        : total,
    emptySemanticUsageAggregate(),
  );
  const readings = passEntries.flatMap((entry) =>
    Array.isArray(entry.semantic_readings)
      ? entry.semantic_readings
          .filter(isSemanticSoakReading)
          .map((reading) => ({ captured_at: entry.ts, reading }))
      : [],
  );
  const accepted = readings.filter(({ reading }) => reading.origin === "model-call");
  const cached = readings.filter(({ reading }) => reading.origin === "cache");
  const omittedReadings = passEntries.reduce(
    (total, entry) => total + (entry.semantic_readings_omitted ?? 0),
    0,
  );
  const service = readSemanticServiceStatus(coordRoot);
  const availableFrom = timestamped[0]?.ts;
  const availableThrough = timestamped.at(-1)?.ts;
  return {
    schema_version: SEMANTIC_SOAK_SCHEMA_VERSION,
    generated_at: endedAt,
    window: {
      requested_minutes: minutes,
      requested_start_at: requestedStart,
      ended_at: endedAt,
      ...(availableFrom ? { available_from: availableFrom } : {}),
      ...(availableThrough ? { available_through: availableThrough } : {}),
      window_complete: availableFrom !== undefined && availableFrom <= requestedStart,
    },
    service: { running: service.running, stale: service.stale },
    coverage: {
      pass_count: passEntries.length,
      instrumented_pass_count: passEntries.filter((entry) => Array.isArray(entry.semantic_readings))
        .length,
      legacy_pass_count: passEntries.filter((entry) => !Array.isArray(entry.semantic_readings))
        .length,
      accepted_reading_count: accepted.length,
      cached_reading_count: cached.length,
    },
    outcomes: usage.outcomes,
    usage,
    readings: summarizeReadings(accepted),
    stability: summarizeStability(accepted),
    limitations: [
      ...(omittedReadings > 0
        ? [`${omittedReadings} semantic readings were omitted at bounded log element boundaries.`]
        : []),
      "Expression frequency counts accepted model readings, not on-screen dwell time.",
      "Cue transitions can reflect real work changes; rapid reversals are review candidates, not proven flicker.",
      "Inference correctness requires labeled review and is not computed by this report.",
    ],
  };
}

function summarizeReadings(readings: readonly TimedReading[]): SemanticSoakReportV1["readings"] {
  const phaseCounts: Partial<Record<SemanticPhase, number>> = {};
  const expressionCounts: Partial<Record<SemanticExpressionCue | "abstained", number>> = {};
  const confidenceCounts: Partial<Record<SemanticConfidence, number>> = {};
  const byHarness: Partial<Record<SemanticHarness, number>> = {};
  for (const { reading } of readings) {
    increment(phaseCounts, reading.phase);
    increment(expressionCounts, reading.expression_cue ?? "abstained");
    if (reading.expression_confidence) increment(confidenceCounts, reading.expression_confidence);
    increment(byHarness, reading.source_harness);
  }
  return {
    phase_counts: phaseCounts,
    expression_counts: expressionCounts,
    expression_confidence_counts: confidenceCounts,
    by_harness: byHarness,
  };
}

function summarizeStability(readings: readonly TimedReading[]): SemanticSoakReportV1["stability"] {
  const bySubject = new Map<string, TimedReading[]>();
  for (const item of readings) {
    const subject = bySubject.get(item.reading.subject_id) ?? [];
    subject.push(item);
    bySubject.set(item.reading.subject_id, subject);
  }
  let repeatedSubjects = 0;
  let adjacentComparisons = 0;
  let unchangedCues = 0;
  let cueChanges = 0;
  let rapidReversals = 0;
  const transitions = new Map<
    string,
    {
      from: SemanticExpressionCue | "abstained";
      to: SemanticExpressionCue | "abstained";
      count: number;
    }
  >();
  for (const subjectReadings of bySubject.values()) {
    subjectReadings.sort((left, right) => left.captured_at.localeCompare(right.captured_at));
    if (subjectReadings.length > 1) repeatedSubjects += 1;
    for (let index = 1; index < subjectReadings.length; index += 1) {
      adjacentComparisons += 1;
      const from = cueOf(subjectReadings[index - 1]!.reading);
      const to = cueOf(subjectReadings[index]!.reading);
      if (from === to) {
        unchangedCues += 1;
      } else {
        cueChanges += 1;
        const key = `${from}\u0000${to}`;
        const current = transitions.get(key) ?? { from, to, count: 0 };
        current.count += 1;
        transitions.set(key, current);
      }
      if (index < 2) continue;
      const earlier = subjectReadings[index - 2]!;
      const middle = subjectReadings[index - 1]!;
      const latest = subjectReadings[index]!;
      if (
        cueOf(earlier.reading) === cueOf(latest.reading) &&
        cueOf(earlier.reading) !== cueOf(middle.reading) &&
        Date.parse(latest.captured_at) - Date.parse(earlier.captured_at) <=
          SEMANTIC_SOAK_REVERSAL_WINDOW_MS
      ) {
        rapidReversals += 1;
      }
    }
  }
  return {
    subject_count: bySubject.size,
    subjects_with_repeat_observations: repeatedSubjects,
    adjacent_comparisons: adjacentComparisons,
    unchanged_cues: unchangedCues,
    cue_changes: cueChanges,
    rapid_reversals: rapidReversals,
    ...(adjacentComparisons > 0
      ? { stable_repeat_rate: Number((unchangedCues / adjacentComparisons).toFixed(3)) }
      : {}),
    transitions: [...transitions.values()].sort(
      (left, right) =>
        right.count - left.count ||
        `${left.from}/${left.to}`.localeCompare(`${right.from}/${right.to}`),
    ),
  };
}

function readSemanticServiceLog(coordRoot: string): SemanticServiceLogEntry[] {
  if (coordEnv("SHARED_LOGS") === "0") {
    return readLegacySemanticServiceLog(coordRoot, MAX_LOG_BYTES).entries;
  }
  let shared: { entries: SemanticServiceLogEntry[]; bytes: number } = { entries: [], bytes: 0 };
  try {
    shared = readSharedSemanticServiceLog(coordRoot, MAX_LOG_BYTES, MAX_LOG_RECORDS);
  } catch {
    // A racing or corrupt best-effort generation yields to bounded historical fallback.
  }
  const remainingBytes = Math.max(0, MAX_LOG_BYTES - shared.bytes);
  const remainingRecords = Math.max(0, MAX_LOG_RECORDS - shared.entries.length);
  const legacy =
    remainingBytes > 0 && remainingRecords > 0
      ? readLegacySemanticServiceLog(coordRoot, remainingBytes, remainingRecords).entries
      : [];
  return mergeSemanticServiceEntries(shared.entries, legacy);
}

function readSharedSemanticServiceLog(
  coordRoot: string,
  maxBytes: number,
  maxRecords: number,
): { entries: SemanticServiceLogEntry[]; bytes: number } {
  const family = createStorageCatalog({ coord_root: coordRoot }).require("semantic-service-log");
  const directory = familyLogDirectory(family);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const manifest = readSegmentManifest(directory, family);
    const generation = manifestGeneration(manifest);
    const sources = [
      ...manifest.segments.map((segment) => ({ path: join(directory, segment.file), gzip: true })),
      { path: join(directory, "active.jsonl"), gzip: false },
    ];
    const entries: SemanticServiceLogEntry[] = [];
    let bytes = 0;
    for (const source of sources) {
      if (!existsSync(source.path) || bytes >= maxBytes || entries.length >= maxRecords) continue;
      let read: { body: string; bytes: number };
      try {
        read = readBoundedLogSource(source.path, source.gzip, maxBytes - bytes);
      } catch {
        continue;
      }
      bytes += read.bytes;
      for (const line of completeLines(read.body)) {
        if (entries.length >= maxRecords) break;
        try {
          const entry = sharedRecordToEntry(parseLogRecord(line));
          if (entry) entries.push(entry);
        } catch {
          // Malformed or partial best-effort records are skipped without widening the budget.
        }
      }
    }
    const after = readSegmentManifest(directory, family);
    if (manifestGeneration(after) === generation) return { entries, bytes };
  }
  return { entries: [], bytes: 0 };
}

function readLegacySemanticServiceLog(
  coordRoot: string,
  maxBytes: number,
  maxRecords = MAX_LOG_RECORDS,
): { entries: SemanticServiceLogEntry[]; bytes: number } {
  const path = semanticPaths(coordRoot).log;
  if (!existsSync(path) || maxBytes <= 0 || maxRecords <= 0) return { entries: [], bytes: 0 };
  const size = statSync(path).size;
  if (size <= 0 || size > maxBytes) return { entries: [], bytes: 0 };
  const body = readFileSync(path, "utf8");
  const entries = body
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return isLogEntry(value) ? [value] : [];
      } catch {
        return [];
      }
    })
    .slice(0, maxRecords);
  return { entries, bytes: Buffer.byteLength(body) };
}

function sharedRecordToEntry(record: HarneryLogRecordV1): SemanticServiceLogEntry | undefined {
  if (record.family_id !== "semantic-service-log") return undefined;
  const usage = parseJsonField(record.fields.usage);
  const semanticReadings = parseJsonField(record.fields.semantic_readings);
  return {
    ts: record.emitted_at,
    event: record.event,
    ...(nonNegativeInteger(record.fields.model_calls) !== undefined
      ? { model_calls: record.fields.model_calls as number }
      : {}),
    ...(nonNegativeInteger(record.fields.cache_hits) !== undefined
      ? { cache_hits: record.fields.cache_hits as number }
      : {}),
    ...(isSemanticUsageAggregate(usage) ? { usage } : {}),
    ...(Array.isArray(semanticReadings)
      ? { semantic_readings: semanticReadings.filter(isSemanticSoakReading) }
      : {}),
    ...(record.fields.semantic_readings_truncated === true
      ? { semantic_readings_truncated: true }
      : {}),
    ...(nonNegativeInteger(record.fields.semantic_readings_omitted) !== undefined
      ? { semantic_readings_omitted: record.fields.semantic_readings_omitted as number }
      : {}),
  };
}

function mergeSemanticServiceEntries(
  shared: readonly SemanticServiceLogEntry[],
  legacy: readonly SemanticServiceLogEntry[],
): SemanticServiceLogEntry[] {
  const merged = new Map<string, SemanticServiceLogEntry>();
  for (const entry of shared) merged.set(logEntryIdentity(entry), entry);
  for (const entry of legacy) {
    const identity = logEntryIdentity(entry);
    if (!merged.has(identity)) merged.set(identity, entry);
  }
  return [...merged.entries()]
    .sort(
      ([leftIdentity, left], [rightIdentity, right]) =>
        left.ts.localeCompare(right.ts) || leftIdentity.localeCompare(rightIdentity),
    )
    .map(([, entry]) => entry);
}

function logEntryIdentity(entry: SemanticServiceLogEntry): string {
  return createHash("sha256")
    .update(
      stableJson([
        entry.ts,
        entry.event,
        entry.model_calls ?? null,
        entry.cache_hits ?? null,
        entry.usage ?? null,
        entry.semantic_readings ?? null,
        entry.semantic_readings_truncated ?? false,
        entry.semantic_readings_omitted ?? 0,
      ]),
    )
    .digest("hex");
}

function readBoundedLogSource(
  path: string,
  gzip: boolean,
  maxBytes: number,
): { body: string; bytes: number } {
  if (maxBytes <= 0) return { body: "", bytes: 0 };
  const size = statSync(path).size;
  if (size <= 0) return { body: "", bytes: 0 };
  if (gzip) {
    if (size > maxBytes) return { body: "", bytes: maxBytes };
    try {
      const body = gunzipSync(readFileSync(path), { maxOutputLength: maxBytes });
      return { body: body.toString("utf8"), bytes: body.byteLength };
    } catch {
      return { body: "", bytes: maxBytes };
    }
  }
  const buffer = Buffer.allocUnsafe(Math.min(size, maxBytes));
  const descriptor = openSync(path, "r");
  try {
    const bytes = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
    return { body: buffer.subarray(0, bytes).toString("utf8"), bytes };
  } finally {
    closeSync(descriptor);
  }
}

function completeLines(body: string): string[] {
  const lastNewline = body.lastIndexOf("\n");
  return lastNewline < 0 ? [] : body.slice(0, lastNewline).split("\n").filter(Boolean);
}

function parseJsonField(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function manifestGeneration(manifest: {
  next_sequence: number;
  segments: readonly { file: string; sha256: string }[];
}): string {
  return JSON.stringify([
    manifest.next_sequence,
    manifest.segments.map((segment) => [segment.file, segment.sha256]),
  ]);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function semanticSubjectId(generationId: string): string {
  return `subject_${createHash("sha256").update(generationId).digest("hex").slice(0, SUBJECT_DIGEST_LENGTH)}`;
}

function cueOf(reading: SemanticSoakReadingV1): SemanticExpressionCue | "abstained" {
  return reading.expression_cue ?? "abstained";
}

function increment<T extends string>(target: Partial<Record<T, number>>, key: T): void {
  target[key] = (target[key] ?? 0) + 1;
}

function positiveMinutes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("minutes must be a positive integer");
  }
  return value;
}

function isLogEntry(value: unknown): value is SemanticServiceLogEntry {
  if (!objectValue(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.ts === "string" && typeof row.event === "string";
}

function isSemanticUsageAggregate(value: unknown): value is SemanticUsageAggregate {
  const row = objectValue(value);
  return (
    !!row &&
    nonNegativeInteger(row.call_count) !== undefined &&
    nonNegativeInteger(row.unreported_calls) !== undefined &&
    isUsageOutcomes(row.outcomes) &&
    isTokenTotals(row.native_tokens) &&
    isTokenTotals(row.estimated_tokens) &&
    Array.isArray(row.breakdowns) &&
    row.breakdowns.every(isUsageBreakdown)
  );
}

function isSemanticSoakReading(value: unknown): value is SemanticSoakReadingV1 {
  const row = objectValue(value);
  return (
    !!row &&
    typeof row.subject_id === "string" &&
    /^subject_[a-f0-9]{16}$/.test(row.subject_id) &&
    validTimestamp(row.generated_at) &&
    (row.origin === "model-call" || row.origin === "cache") &&
    member(SEMANTIC_HARNESSES, row.source_harness) &&
    member(SEMANTIC_CONFIGURED_MODELS, row.configured_model) &&
    member(SEMANTIC_PHASES, row.phase) &&
    confidence(row.phase_confidence) &&
    (row.expression_cue === undefined || member(SEMANTIC_EXPRESSION_CUES, row.expression_cue)) &&
    (row.expression_confidence === undefined || confidence(row.expression_confidence))
  );
}

function isUsageOutcomes(value: unknown): boolean {
  const row = objectValue(value);
  return (
    !!row &&
    ["accepted", "invalid", "unavailable", "deferred"].every(
      (key) => nonNegativeInteger(row[key]) !== undefined,
    )
  );
}

function isTokenTotals(value: unknown): boolean {
  const row = objectValue(value);
  if (!row) return false;
  return Object.entries(row).every(
    ([key, count]) =>
      [
        "input_tokens",
        "cached_input_tokens",
        "cache_creation_input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "total_tokens",
      ].includes(key) && nonNegativeInteger(count) !== undefined,
  );
}

function isUsageBreakdown(value: unknown): boolean {
  const row = objectValue(value);
  return (
    !!row &&
    nonNegativeInteger(row.call_count) !== undefined &&
    nonNegativeInteger(row.unreported_calls) !== undefined &&
    isUsageOutcomes(row.outcomes) &&
    isTokenTotals(row.native_tokens) &&
    isTokenTotals(row.estimated_tokens) &&
    !!objectValue(row.invalid_reasons)
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function member<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function confidence(value: unknown): value is SemanticConfidence {
  return value === "high" || value === "medium" || value === "low";
}
