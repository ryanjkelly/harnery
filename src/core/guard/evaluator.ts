import type {
  EvaluateRunQualityInput,
  RunQualityEvaluatorState,
  RunQualityEvidenceEvent,
  RunQualitySignal,
  RunQualitySnapshot,
  RunQualityStatus,
} from "./types.ts";
import { RUN_QUALITY_SCHEMA_VERSION } from "./types.ts";

const LEVELS: RunQualityStatus[] = ["unknown", "healthy", "attention", "critical"];

/** Pure report-only transition. It has no filesystem, process, or verdict dependencies. */
export function evaluateRunQuality(input: EvaluateRunQualityInput): RunQualitySnapshot {
  const configChanged = !!input.previous && input.previous.config_digest !== input.config_digest;
  const sameGeneration =
    !input.previous || input.previous.session_generation === input.session_generation;
  const priorState = !configChanged && sameGeneration ? input.previous?.state : undefined;
  const state = cloneState(priorState);
  const events = [...input.events].sort(compareEvidence);
  let progressSeen = false;
  let newEvidence = false;

  for (const event of events) {
    if (input.previous?.evidence.last_event_id === event.event_id) continue;
    newEvidence = true;
    progressSeen = applyEvidence(state, event, input) || progressSeen;
  }

  const legitimateWait = input.role_wait.fresh && input.role_wait.wait_kind !== "none";
  const deadlineEpoch = !newEvidence && input.live && !legitimateWait;
  const epoch = newEvidence ? "evidence" : deadlineEpoch ? "deadline" : "read";

  const inGrace = graceActive(state, input.now);
  const signals = buildSignals(state, input, inGrace);
  const precursorFamilies = new Set(
    signals
      .filter(
        (signal) =>
          signal.state === "active" &&
          signal.id !== "no_progress" &&
          signal.id !== "compaction_grace",
      )
      .map((signal) =>
        signal.id === "repeated_tool_calls" || signal.id === "target_stagnation"
          ? "tool_behavior"
          : signal.id,
      ),
  ).size;

  if (progressSeen) {
    state.no_progress_epochs = 0;
    state.no_progress_deadline_epochs = 0;
  } else if (precursorFamilies >= 2 && (newEvidence || deadlineEpoch)) {
    state.no_progress_epochs++;
    if (deadlineEpoch) state.no_progress_deadline_epochs++;
  }
  replaceSignal(signals, noProgressSignal(state, input, inGrace, legitimateWait));

  let desired = desiredStatus(signals, input.sufficient_history, input.evidence.truncated);
  if (progressSeen && desired === "critical") desired = "attention";
  const previousStatus = input.previous?.status ?? "unknown";
  const transitionBase = configChanged || !sameGeneration ? "unknown" : previousStatus;
  const status = stepOneLevel(transitionBase, desired);
  const evaluatedAt = input.now;
  const nextEligibleAt = addSeconds(evaluatedAt, input.config.evaluation_interval_seconds);
  const expiresAt = addSeconds(evaluatedAt, input.config.snapshot_ttl_seconds);

  return {
    schema_version: RUN_QUALITY_SCHEMA_VERSION,
    instance_id: input.instance_id,
    session_id: input.session_id,
    session_generation: input.session_generation,
    adapter: input.adapter,
    config_digest: input.config_digest,
    mode: input.config.mode === "report" ? "report" : "shadow",
    status,
    previous_status: previousStatus,
    evaluated_at: evaluatedAt,
    next_eligible_at: nextEligibleAt,
    expires_at: expiresAt,
    evidence: input.evidence,
    signals,
    role_wait: input.role_wait,
    state,
    epoch,
    reason: configChanged
      ? "config_changed"
      : !input.sufficient_history || input.evidence.truncated
        ? "insufficient_evidence"
        : deadlineEpoch
          ? "deadline"
          : "evidence",
  };
}

function applyEvidence(
  state: RunQualityEvaluatorState,
  event: RunQualityEvidenceEvent,
  input: EvaluateRunQualityInput,
): boolean {
  switch (event.kind) {
    case "tool_call":
      state.work_since_progress++;
      if (event.target_hash) {
        state.target_hash_seen = true;
        if (state.target_hash === event.target_hash) state.target_streak++;
        else {
          state.target_hash = event.target_hash;
          state.target_streak = 1;
        }
      }
      if (!event.input_hash) {
        state.missing_hash_seen = true;
        return false;
      }
      state.exact_hash_seen = true;
      if (state.repeated_hash === event.input_hash) state.repeated_count++;
      else {
        state.repeated_hash = event.input_hash;
        state.repeated_count = 1;
      }
      return false;
    case "tool_success":
      state.failure_streak = 0;
      return false;
    case "tool_failure":
      state.failure_streak++;
      return false;
    case "progress":
      state.work_since_progress = 0;
      state.target_streak = 0;
      return true;
    case "context_sample":
      applyContextSample(state, event, input.adapter);
      return false;
    case "compaction_started":
      state.compaction_grace_until = addSeconds(
        event.ts,
        input.config.thresholds.compaction_grace_seconds,
      );
      return false;
    case "compaction_completed":
      state.compaction_grace_until = addSeconds(
        event.ts,
        input.config.thresholds.compaction_grace_seconds,
      );
      return true;
  }
}

function applyContextSample(
  state: RunQualityEvaluatorState,
  event: RunQualityEvidenceEvent,
  adapter: string,
): void {
  if (
    event.used_tokens === undefined ||
    !Number.isFinite(event.used_tokens) ||
    !attestedContextSource(adapter, event.telemetry_source, event.confidence)
  ) {
    return;
  }
  const previous = state.last_context;
  if (previous) {
    const minutes = (Date.parse(event.ts) - Date.parse(previous.ts)) / 60_000;
    if (Number.isFinite(minutes) && minutes > 0) {
      state.context_growth_per_minute = (event.used_tokens - previous.used_tokens) / minutes;
    }
  }
  state.last_context = { used_tokens: event.used_tokens, ts: event.ts };
}

function attestedContextSource(
  adapter: string,
  source: string | undefined,
  confidence: RunQualityEvidenceEvent["confidence"],
): boolean {
  if (confidence !== "exact" && confidence !== "reported") return false;
  const allowed: Record<string, readonly string[]> = {
    "claude-code": ["hook", "native_event", "result"],
    codex: ["native_event", "result", "transcript"],
    cursor: ["native_event"],
  };
  return !!source && (allowed[adapter] ?? []).includes(source);
}

function buildSignals(
  state: RunQualityEvaluatorState,
  input: EvaluateRunQualityInput,
  inGrace: boolean,
): RunQualitySignal[] {
  const t = input.config.thresholds;
  return [
    thresholdSignal(
      "repeated_tool_calls",
      state.repeated_count,
      t.repeated_tool_calls,
      state.exact_hash_seen ? "exact_input_hash" : "exact_input_hash_unavailable",
      !state.exact_hash_seen && state.missing_hash_seen,
    ),
    thresholdSignal(
      "consecutive_failures",
      state.failure_streak,
      t.consecutive_failures,
      "consecutive_outcomes",
      false,
    ),
    inGrace
      ? signal("context_growth", "suppressed", "none", 0, "compaction_grace")
      : state.context_growth_per_minute === undefined
        ? signal("context_growth", "unknown", "none", 0, "attested_samples_unavailable")
        : thresholdSignal(
            "context_growth",
            Math.max(0, Math.round(state.context_growth_per_minute)),
            t.context_growth_per_minute,
            "attested_context_velocity",
            false,
          ),
    thresholdSignal(
      "target_stagnation",
      state.target_streak,
      t.repeated_tool_calls,
      "same_target_without_progress_event",
      !state.target_hash_seen,
    ),
    signal("no_progress", "inactive", "none", state.no_progress_epochs, "not_corroborated"),
    inGrace
      ? signal("compaction_grace", "active", "none", 1, "within_grace_deadline")
      : signal("compaction_grace", "inactive", "none", 0, "outside_grace_deadline"),
  ];
}

function noProgressSignal(
  state: RunQualityEvaluatorState,
  input: EvaluateRunQualityInput,
  inGrace: boolean,
  legitimateWait: boolean,
): RunQualitySignal {
  if (inGrace) return signal("no_progress", "suppressed", "none", 0, "compaction_grace");
  if (legitimateWait) return signal("no_progress", "suppressed", "none", 0, "legitimate_wait");
  if (state.no_progress_deadline_epochs < 1) {
    return signal(
      "no_progress",
      "inactive",
      "none",
      state.no_progress_epochs,
      "deadline_epoch_required",
    );
  }
  return thresholdSignal(
    "no_progress",
    state.no_progress_epochs,
    input.config.thresholds.no_progress_evaluations,
    "corroborated_epochs",
    false,
  );
}

function thresholdSignal(
  id: RunQualitySignal["id"],
  count: number,
  threshold: number,
  reason: string,
  unknown: boolean,
): RunQualitySignal {
  if (unknown) return signal(id, "unknown", "none", count, reason);
  if (count >= threshold * 2) return signal(id, "active", "critical", count, reason);
  if (count >= threshold) return signal(id, "active", "attention", count, reason);
  return signal(id, "inactive", "none", count, reason);
}

function signal(
  id: RunQualitySignal["id"],
  state: RunQualitySignal["state"],
  severity: RunQualitySignal["severity"],
  count: number,
  reason_code: string,
): RunQualitySignal {
  return { id, state, severity, count, reason_code };
}

function replaceSignal(signals: RunQualitySignal[], next: RunQualitySignal): void {
  const index = signals.findIndex((signal) => signal.id === next.id);
  if (index >= 0) signals[index] = next;
}

function desiredStatus(
  signals: RunQualitySignal[],
  sufficientHistory: boolean,
  truncated: boolean,
): RunQualityStatus {
  if (!sufficientHistory || truncated) return "unknown";
  if (signals.some((signal) => signal.state === "active" && signal.severity === "critical")) {
    return "critical";
  }
  if (signals.some((signal) => signal.state === "active" && signal.severity === "attention")) {
    return "attention";
  }
  return "healthy";
}

function stepOneLevel(previous: RunQualityStatus, desired: RunQualityStatus): RunQualityStatus {
  if (previous === desired) return previous;
  if (previous === "unknown") return desired === "critical" ? "attention" : desired;
  if (desired === "unknown") return "unknown";
  const from = LEVELS.indexOf(previous);
  const to = LEVELS.indexOf(desired);
  return LEVELS[from + Math.sign(to - from)] ?? desired;
}

function graceActive(state: RunQualityEvaluatorState, now: string): boolean {
  if (!state.compaction_grace_until) return false;
  return Date.parse(now) < Date.parse(state.compaction_grace_until);
}

function cloneState(previous?: RunQualityEvaluatorState): RunQualityEvaluatorState {
  return previous
    ? structuredClone(previous)
    : {
        repeated_count: 0,
        exact_hash_seen: false,
        missing_hash_seen: false,
        target_streak: 0,
        target_hash_seen: false,
        failure_streak: 0,
        work_since_progress: 0,
        no_progress_epochs: 0,
        no_progress_deadline_epochs: 0,
      };
}

function compareEvidence(a: RunQualityEvidenceEvent, b: RunQualityEvidenceEvent): number {
  return a.event_id.localeCompare(b.event_id) || a.ts.localeCompare(b.ts);
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
