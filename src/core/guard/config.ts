import { createHash } from "node:crypto";
import { coordRunQualityConfigSource } from "../config.ts";
import type { RunQualityConfig, RunQualityConfigResult, RunQualityMode } from "./types.ts";

export const DEFAULT_RUN_QUALITY_CONFIG: RunQualityConfig = {
  mode: "off",
  evaluation_interval_seconds: 30,
  snapshot_ttl_seconds: 120,
  max_tail_bytes: 2 * 1024 * 1024,
  evaluation_timeout_seconds: 30,
  lock_stale_seconds: 60,
  supervised_roots_per_sweep: 8,
  thresholds: {
    repeated_tool_calls: 8,
    consecutive_failures: 5,
    context_growth_per_minute: 60_000,
    compaction_grace_seconds: 300,
    no_progress_evaluations: 2,
  },
};

const RANGES = {
  evaluation_interval_seconds: [5, 3600],
  snapshot_ttl_seconds: [10, 86_400],
  max_tail_bytes: [64 * 1024, 64 * 1024 * 1024],
  evaluation_timeout_seconds: [1, 30],
  lock_stale_seconds: [5, 3600],
  supervised_roots_per_sweep: [1, 100],
  repeated_tool_calls: [2, 10_000],
  consecutive_failures: [1, 10_000],
  context_growth_per_minute: [1, 10_000_000],
  compaction_grace_seconds: [0, 86_400],
  no_progress_evaluations: [1, 10_000],
} as const;

/** Read and validate the project-owned coord.run_quality object as one unit. */
export function readRunQualityConfig(coordRoot: string): RunQualityConfigResult {
  const source = coordRunQualityConfigSource(coordRoot);
  if (source.invalid) return invalid(source.digest_seed, "config_json_invalid", "off");
  const value = source.value;
  if (value === undefined) return result(DEFAULT_RUN_QUALITY_CONFIG, true, []);
  const rq = record(value);
  const mode = modeOf(rq?.mode);
  if (!rq || !mode) return invalid(value, "run_quality_object_invalid", mode ?? "off");

  const config: RunQualityConfig = {
    mode,
    evaluation_interval_seconds: numberOrDefault(
      rq.evaluation_interval_seconds,
      DEFAULT_RUN_QUALITY_CONFIG.evaluation_interval_seconds,
    ),
    snapshot_ttl_seconds: numberOrDefault(
      rq.snapshot_ttl_seconds,
      DEFAULT_RUN_QUALITY_CONFIG.snapshot_ttl_seconds,
    ),
    max_tail_bytes: numberOrDefault(rq.max_tail_bytes, DEFAULT_RUN_QUALITY_CONFIG.max_tail_bytes),
    evaluation_timeout_seconds: numberOrDefault(
      rq.evaluation_timeout_seconds,
      DEFAULT_RUN_QUALITY_CONFIG.evaluation_timeout_seconds,
    ),
    lock_stale_seconds: numberOrDefault(
      rq.lock_stale_seconds,
      DEFAULT_RUN_QUALITY_CONFIG.lock_stale_seconds,
    ),
    supervised_roots_per_sweep: numberOrDefault(
      rq.supervised_roots_per_sweep,
      DEFAULT_RUN_QUALITY_CONFIG.supervised_roots_per_sweep,
    ),
    thresholds: {
      repeated_tool_calls: numberOrDefault(
        record(rq.thresholds)?.repeated_tool_calls,
        DEFAULT_RUN_QUALITY_CONFIG.thresholds.repeated_tool_calls,
      ),
      consecutive_failures: numberOrDefault(
        record(rq.thresholds)?.consecutive_failures,
        DEFAULT_RUN_QUALITY_CONFIG.thresholds.consecutive_failures,
      ),
      context_growth_per_minute: numberOrDefault(
        record(rq.thresholds)?.context_growth_per_minute,
        DEFAULT_RUN_QUALITY_CONFIG.thresholds.context_growth_per_minute,
      ),
      compaction_grace_seconds: numberOrDefault(
        record(rq.thresholds)?.compaction_grace_seconds,
        DEFAULT_RUN_QUALITY_CONFIG.thresholds.compaction_grace_seconds,
      ),
      no_progress_evaluations: numberOrDefault(
        record(rq.thresholds)?.no_progress_evaluations,
        DEFAULT_RUN_QUALITY_CONFIG.thresholds.no_progress_evaluations,
      ),
    },
  };
  const reasons = validate(config, rq);
  return reasons.length > 0 ? invalid(value, reasons, mode) : result(config, true, []);
}

function validate(config: RunQualityConfig, raw: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const allowedTop = new Set([
    "mode",
    "evaluation_interval_seconds",
    "snapshot_ttl_seconds",
    "max_tail_bytes",
    "evaluation_timeout_seconds",
    "lock_stale_seconds",
    "supervised_roots_per_sweep",
    "thresholds",
  ]);
  if (Object.keys(raw).some((key) => !allowedTop.has(key))) reasons.push("unknown_field");
  const top = [
    "evaluation_interval_seconds",
    "snapshot_ttl_seconds",
    "max_tail_bytes",
    "evaluation_timeout_seconds",
    "lock_stale_seconds",
    "supervised_roots_per_sweep",
  ] as const;
  for (const key of top) validateInteger(key, config[key], raw[key], reasons);
  if (config.lock_stale_seconds <= config.evaluation_timeout_seconds) {
    reasons.push("lock_stale_not_above_timeout");
  }
  if (config.snapshot_ttl_seconds < config.evaluation_interval_seconds) {
    reasons.push("snapshot_ttl_below_interval");
  }
  const thresholds = record(raw.thresholds);
  if (raw.thresholds !== undefined && !thresholds) reasons.push("thresholds_invalid");
  const allowedThresholds = new Set(Object.keys(config.thresholds));
  if (thresholds && Object.keys(thresholds).some((key) => !allowedThresholds.has(key))) {
    reasons.push("thresholds_unknown_field");
  }
  for (const key of Object.keys(config.thresholds) as Array<keyof RunQualityConfig["thresholds"]>) {
    validateInteger(key, config.thresholds[key], thresholds?.[key], reasons);
  }
  return reasons;
}

function validateInteger(
  key: keyof typeof RANGES,
  value: number,
  supplied: unknown,
  reasons: string[],
): void {
  if (supplied !== undefined && (!Number.isSafeInteger(supplied) || supplied !== value)) {
    reasons.push(`${key}_not_integer`);
    return;
  }
  const [min, max] = RANGES[key];
  if (value < min || value > max) reasons.push(`${key}_out_of_range`);
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function modeOf(value: unknown): RunQualityMode | null {
  return value === "off" || value === "shadow" || value === "report" ? value : null;
}

function result(
  config: RunQualityConfig,
  valid: boolean,
  reasonCodes: string[],
): RunQualityConfigResult {
  return {
    config,
    digest: digest(config),
    valid,
    requested_mode: config.mode,
    reason_codes: reasonCodes,
  };
}

function invalid(
  value: unknown,
  reasons: string | string[],
  mode: RunQualityMode,
): RunQualityConfigResult {
  return {
    config: null,
    digest: digest(value),
    valid: false,
    requested_mode: mode,
    reason_codes: Array.isArray(reasons) ? reasons : [reasons],
  };
}

function digest(value: unknown): string {
  const body = typeof value === "string" ? value : stableJson(value);
  return createHash("sha256").update(body).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
