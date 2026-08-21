/**
 * Bounded V3 activity reducers for Codec.
 *
 * This module folds only `CodecSourceEvidence`, never raw ledger rows. It
 * correlates span/wait identifiers, opaque fingerprints, output counts,
 * artifact operations, claims, and observation-quality defects into small
 * presentation channels. No reducer retains command text, paths, prompts,
 * output content, or error bodies because those fields cannot enter the
 * source-evidence contract in the first place.
 */

import type {
  CodecActionCategory,
  CodecArtifactValue,
  CodecFriction,
  CodecOperationValue,
  CodecPanelScene,
  CodecSourceEvidence,
  CodecTelemetry,
  CodecTelemetryReason,
  Presented,
} from "./contracts";

const OUTPUT_FLOW_TTL_MS = 8_000;
const ARTIFACT_TTL_MS = 2 * 60_000;
const ERROR_TTL_MS = 5 * 60_000;
const REPEAT_TTL_MS = 5 * 60_000;
const CONTENTION_TTL_MS = 60_000;
const TELEMETRY_TTL_MS = 5 * 60_000;
const OPEN_SPAN_CAP = 24;
const COMPARISON_CAP = 48;
const DURATION_SAMPLE_CAP = 128;
const MIN_DURATION_SAMPLES = 8;
const LONG_RUNNING_MULTIPLIER = 1.5;
const LONG_RUNNING_FLOOR_MS = 30_000;

interface OpenOperation {
  key: string;
  spanId?: string;
  parentSpanId?: string;
  waitId?: string;
  eventId: string;
  ts: string;
  turnId?: string;
  category: CodecActionCategory;
  label: string;
  baselineKey: string;
  fingerprint?: string;
  targetFingerprint?: string;
  outputCount: number;
  outputBytes: number;
  lastOutputTs?: string;
  retryEvidenceIds?: string[];
  orderReliable: boolean;
}

interface TerminalAttempt {
  outcome: "ok" | "error" | "unknown";
  eventId: string;
  ts: string;
  turnId?: string;
}

interface FrictionRecord {
  value: CodecFriction;
  ts: string;
  eventIds: string[];
  ttlMs: number;
}

interface InstanceActivityState {
  open: Map<string, OpenOperation>;
  compaction?: { ts: string; eventId: string };
  lastCompactionCompletedTs?: string;
  pendingTerminals: Map<string, CodecSourceEvidence>;
  closedTurns: Map<string, true>;
  lastTerminalByFingerprint: Map<string, TerminalAttempt>;
  startsByTurnFingerprint: Map<string, { count: number; eventIds: string[]; ts: string }>;
  lastTargetFingerprint?: string;
  artifact?: { value: CodecArtifactValue; ts: string; eventId: string };
  friction?: FrictionRecord;
  telemetry?: { ts: string; eventId: string; reason: CodecTelemetryReason };
  activeWriteClaims: Map<string, { ts: string; eventId: string }>;
}

export interface CodecActivityChannels {
  operation?: Presented<CodecOperationValue>;
  artifact_cue?: Presented<CodecArtifactValue>;
  friction?: Presented<CodecFriction>;
  telemetry: Presented<CodecTelemetry>;
  telemetry_reason?: Presented<CodecTelemetryReason>;
}

function state(): InstanceActivityState {
  return {
    open: new Map(),
    pendingTerminals: new Map(),
    closedTurns: new Map(),
    lastTerminalByFingerprint: new Map(),
    startsByTurnFingerprint: new Map(),
    activeWriteClaims: new Map(),
  };
}

function millis(ts: string | undefined): number {
  const parsed = ts ? Date.parse(ts) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function fingerprintKey(
  fingerprint: CodecSourceEvidence["operation_fingerprint"] | undefined,
): string | undefined {
  return fingerprint
    ? `${fingerprint.key_epoch}:${fingerprint.scope}:${fingerprint.digest}`
    : undefined;
}

function targetFingerprintKey(
  fingerprint: CodecSourceEvidence["target_fingerprint"] | undefined,
): string | undefined {
  return fingerprintKey(fingerprint);
}

function trimMap<K, V>(map: Map<K, V>, cap: number): void {
  while (map.size > cap) {
    const first = map.keys().next().value as K | undefined;
    if (first === undefined) return;
    map.delete(first);
  }
}

function present<T>(
  value: T,
  provenance: Presented<T>["provenance"],
  confidence: Presented<T>["confidence"],
  observedAt: string,
  eventIds?: string[],
  expiresAt?: string,
): Presented<T> {
  return {
    value,
    provenance,
    confidence,
    observed_at: observedAt,
    ...(eventIds?.length ? { evidence_event_ids: eventIds.slice(-3) } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
  };
}

function expiry(ts: string, ttlMs: number): string {
  return new Date(millis(ts) + ttlMs).toISOString();
}

function operationLabel(event: CodecSourceEvidence): string {
  if (event.wait_kind) {
    const waits: Record<string, string> = {
      permission: "Waiting for permission",
      needs_input: "Waiting for input",
      decision: "Waiting for a decision",
      approval: "Waiting for approval",
      dependency: "Waiting on a dependency",
      scheduled: "Scheduled wait",
      rate_limit: "Rate-limit wait",
      unknown: "Waiting",
    };
    return waits[event.wait_kind] ?? "Waiting";
  }
  const key = `${event.tool_namespace ?? ""}/${event.tool_name ?? ""}`.toLowerCase();
  if (key.includes("apply_patch")) return "Editing files";
  if (key.includes("exec_command")) return "Running a command";
  if (key.includes("view_image")) return "Reviewing an image";
  if (key.includes("web__run") || key.includes("web/run")) return "Researching the web";
  if (key.includes("update_plan")) return "Updating the plan";
  if (/collaboration|spawn_agent|send_message|followup_task|wait_agent/.test(key)) {
    return "Coordinating agents";
  }
  const names: Record<string, string> = {
    Read: "Reading",
    Grep: "Searching code",
    Glob: "Finding files",
    Edit: "Editing files",
    Write: "Writing files",
    WebFetch: "Reading the web",
    WebSearch: "Researching the web",
  };
  if (event.tool_name && names[event.tool_name]) return names[event.tool_name] ?? "Working";
  if (event.tool_namespace === "command" && event.tool_name) {
    return `Running ${humanizeToken(event.tool_name)}`;
  }
  const verbs: Record<CodecActionCategory, string> = {
    research: "Researching",
    diagnostic: "Diagnosing",
    build: "Building",
    edit: "Editing",
    test: "Testing",
    coordinate: "Coordinating",
    other: "Working",
  };
  return event.tool_name
    ? `${verbs[event.category ?? "other"]} with ${humanizeToken(event.tool_name)}`
    : verbs[event.category ?? "other"];
}

function humanizeToken(value: string): string {
  return value.replace(/[_-]+/g, " ").slice(0, 40);
}

function openKey(event: CodecSourceEvidence): string | undefined {
  if (event.span_id) return `span:${event.span_id}`;
  if (event.wait_id) return `wait:${event.wait_id}`;
  return undefined;
}

function recoveryRequestKey(eventId: string | undefined): string | undefined {
  return eventId ? `request:${eventId}` : undefined;
}

function clearForwardProgress(slot: InstanceActivityState): void {
  if (slot.friction?.value === "repeating-operation") slot.friction = undefined;
  slot.startsByTurnFingerprint.clear();
}

function recordStart(
  slot: InstanceActivityState,
  event: CodecSourceEvidence,
  durationBaselines: Map<string, number[]>,
): void {
  if (event.turn_id && slot.closedTurns.has(event.turn_id)) return;
  const key = openKey(event);
  if (!key) return;
  const operationFingerprint = fingerprintKey(event.operation_fingerprint);
  const targetFingerprint = targetFingerprintKey(event.target_fingerprint);
  if (
    targetFingerprint &&
    slot.lastTargetFingerprint &&
    targetFingerprint !== slot.lastTargetFingerprint
  ) {
    clearForwardProgress(slot);
  }
  if (targetFingerprint) slot.lastTargetFingerprint = targetFingerprint;

  const operation: OpenOperation = {
    key,
    ...(event.span_id ? { spanId: event.span_id } : {}),
    ...(event.parent_span_id ? { parentSpanId: event.parent_span_id } : {}),
    ...(event.wait_id ? { waitId: event.wait_id } : {}),
    eventId: event.event_id,
    ts: event.ts,
    ...(event.turn_id ? { turnId: event.turn_id } : {}),
    category: event.category ?? "coordinate",
    label: operationLabel(event),
    baselineKey: `${event.adapter ?? "unknown"}/${event.tool_namespace ?? "wait"}/${event.tool_name ?? event.wait_kind ?? "unknown"}`,
    ...(operationFingerprint ? { fingerprint: operationFingerprint } : {}),
    ...(targetFingerprint ? { targetFingerprint } : {}),
    outputCount: 0,
    outputBytes: 0,
    orderReliable: event.telemetry_issue === undefined,
  };

  if (operationFingerprint && operation.orderReliable) {
    const prior = slot.lastTerminalByFingerprint.get(operationFingerprint);
    if (
      prior &&
      prior.outcome !== "ok" &&
      prior.turnId === event.turn_id &&
      millis(event.ts) >= millis(prior.ts)
    ) {
      operation.retryEvidenceIds = [prior.eventId, event.event_id];
    }
    const countKey = `${event.turn_id ?? "no-turn"}:${operationFingerprint}`;
    const priorCount = slot.startsByTurnFingerprint.get(countKey);
    const nextCount = {
      count: (priorCount?.count ?? 0) + 1,
      eventIds: [...(priorCount?.eventIds ?? []), event.event_id].slice(-3),
      ts: event.ts,
    };
    slot.startsByTurnFingerprint.set(countKey, nextCount);
    trimMap(slot.startsByTurnFingerprint, COMPARISON_CAP);
    if (nextCount.count >= 3) {
      slot.friction = {
        value: "repeating-operation",
        ts: event.ts,
        eventIds: nextCount.eventIds,
        ttlMs: REPEAT_TTL_MS,
      };
    }
  }
  slot.open.set(key, operation);
  trimMap(slot.open, OPEN_SPAN_CAP);

  const pending =
    slot.pendingTerminals.get(key) ??
    slot.pendingTerminals.get(recoveryRequestKey(event.event_id) ?? "");
  if (pending) recordTerminal(slot, pending, durationBaselines, key);
}

function recordTerminal(
  slot: InstanceActivityState,
  event: CodecSourceEvidence,
  durationBaselines: Map<string, number[]>,
  matchedKey?: string,
): void {
  const directKey = openKey(event);
  const requestKey = recoveryRequestKey(event.recovery_requested_event_id);
  const requestMatchedKey = requestKey
    ? [...slot.open.entries()].find(
        ([, operation]) => requestKey === recoveryRequestKey(operation.eventId),
      )?.[0]
    : undefined;
  const key = matchedKey ?? (directKey && slot.open.has(directKey) ? directKey : requestMatchedKey);
  const open = key ? slot.open.get(key) : undefined;
  if (key) slot.open.delete(key);
  if (open) {
    if (directKey) slot.pendingTerminals.delete(directKey);
    if (requestKey) slot.pendingTerminals.delete(requestKey);
  }
  if (!open?.fingerprint) {
    if (!open) {
      if (directKey) slot.pendingTerminals.set(directKey, event);
      if (requestKey) slot.pendingTerminals.set(requestKey, event);
      trimMap(slot.pendingTerminals, COMPARISON_CAP);
    }
    if (event.outcome === "error") {
      slot.friction = {
        value: "recent-error",
        ts: event.ts,
        eventIds: [event.event_id],
        ttlMs: ERROR_TTL_MS,
      };
    }
    return;
  }
  const terminal: TerminalAttempt = {
    outcome: event.outcome === "ok" || event.outcome === "error" ? event.outcome : "unknown",
    eventId: event.event_id,
    ts: event.ts,
    ...(open.turnId ? { turnId: open.turnId } : {}),
  };
  if (open.orderReliable && event.telemetry_issue === undefined) {
    slot.lastTerminalByFingerprint.delete(open.fingerprint);
    slot.lastTerminalByFingerprint.set(open.fingerprint, terminal);
    trimMap(slot.lastTerminalByFingerprint, COMPARISON_CAP);
  }
  if (terminal.outcome === "ok" && event.duration_ms !== undefined) {
    const samples = durationBaselines.get(open.baselineKey) ?? [];
    samples.push(event.duration_ms);
    if (samples.length > DURATION_SAMPLE_CAP) samples.shift();
    durationBaselines.set(open.baselineKey, samples);
    trimMap(durationBaselines, COMPARISON_CAP);
  }
  if (terminal.outcome === "ok") {
    if (slot.friction?.value === "repeating-operation") slot.friction = undefined;
  } else if (terminal.outcome === "error") {
    slot.friction = {
      value: "recent-error",
      ts: event.ts,
      eventIds: [open.eventId, event.event_id],
      ttlMs: ERROR_TTL_MS,
    };
  }
}

function newestOpen(slot: InstanceActivityState): OpenOperation | undefined {
  const operations = [...slot.open.values()];
  const parentSpanIds = new Set(
    operations
      .map((operation) => operation.parentSpanId)
      .filter((spanId): spanId is string => spanId !== undefined),
  );
  const leaves = operations.filter(
    (operation) => !operation.spanId || !parentSpanIds.has(operation.spanId),
  );
  const candidates = leaves.length > 0 ? leaves : operations;
  if (candidates.every((operation) => operation.orderReliable)) {
    return candidates.sort((a, b) => millis(b.ts) - millis(a.ts))[0];
  }
  return candidates.at(-1);
}

/** Fold V3-safe evidence into per-panel activity channels. */
export function projectActivityChannels(
  events: readonly CodecSourceEvidence[],
  now: string,
): Map<string, CodecActivityChannels> {
  const states = new Map<string, InstanceActivityState>();
  const seenEventIds = new Set<string>();
  const durationBaselines = new Map<string, number[]>();
  const get = (instanceId: string) => {
    let slot = states.get(instanceId);
    if (!slot) {
      slot = state();
      states.set(instanceId, slot);
    }
    return slot;
  };

  for (const event of events) {
    if (seenEventIds.has(event.event_id)) continue;
    seenEventIds.add(event.event_id);
    const slot = get(event.instance_id);
    if (event.telemetry_issue) {
      slot.telemetry = { ts: event.ts, eventId: event.event_id, reason: event.telemetry_issue };
    }
    if (event.context_observation_state === "expected_but_missing") {
      slot.telemetry = {
        ts: event.ts,
        eventId: event.event_id,
        reason: "context-observation-missing",
      };
    }
    switch (event.event_type) {
      case "tool.requested":
      case "command.started":
      case "wait.started":
        recordStart(slot, event, durationBaselines);
        break;
      case "command.output_observed": {
        const key = openKey(event);
        const open = key ? slot.open.get(key) : undefined;
        if (open && event.telemetry_issue === undefined) {
          open.outputCount += 1;
          open.outputBytes += event.output_bytes ?? 0;
          open.lastOutputTs = event.ts;
        }
        break;
      }
      case "tool.completed":
      case "command.completed":
      case "wait.ended":
        recordTerminal(slot, event, durationBaselines);
        break;
      case "artifact.observed":
        if (event.artifact_kind && event.artifact_operation) {
          slot.artifact = {
            value: { kind: event.artifact_kind.slice(0, 48), operation: event.artifact_operation },
            ts: event.ts,
            eventId: event.event_id,
          };
          clearForwardProgress(slot);
        }
        break;
      case "progress.observed":
        clearForwardProgress(slot);
        break;
      case "context.compaction_started":
        if (
          !slot.lastCompactionCompletedTs ||
          millis(event.ts) > millis(slot.lastCompactionCompletedTs)
        ) {
          slot.compaction = { ts: event.ts, eventId: event.event_id };
        }
        break;
      case "context.compaction_completed":
        slot.compaction = undefined;
        slot.lastCompactionCompletedTs = event.ts;
        break;
      case "coord.claim_changed": {
        const target = targetFingerprintKey(event.target_fingerprint);
        if (!target || event.claim_access !== "write") break;
        if (event.claim_operation === "acquired") {
          slot.activeWriteClaims.set(target, { ts: event.ts, eventId: event.event_id });
          trimMap(slot.activeWriteClaims, COMPARISON_CAP);
        } else if (event.claim_operation === "released") {
          slot.activeWriteClaims.delete(target);
        } else if (event.claim_operation === "denied") {
          slot.friction = {
            value: "target-contention",
            ts: event.ts,
            eventIds: [event.event_id],
            ttlMs: CONTENTION_TTL_MS,
          };
        }
        break;
      }
      case "turn.completed":
        slot.open.clear();
        if (event.turn_id) {
          slot.closedTurns.set(event.turn_id, true);
          trimMap(slot.closedTurns, COMPARISON_CAP);
          for (const [key, pending] of slot.pendingTerminals) {
            if (pending.turn_id === event.turn_id) slot.pendingTerminals.delete(key);
          }
        }
        slot.startsByTurnFingerprint.clear();
        if (slot.friction?.value === "repeating-operation") slot.friction = undefined;
        break;
      case "session.ended":
      case "agent.completed":
        slot.open.clear();
        slot.compaction = undefined;
        slot.pendingTerminals.clear();
        slot.activeWriteClaims.clear();
        break;
      default:
        break;
    }
  }

  // A denied claim is direct evidence. Overlapping active write claims are a
  // second, conservative contention signal; only the opaque target digest is
  // compared and no path is exposed.
  const claimants = new Map<
    string,
    Array<{ slot: InstanceActivityState; eventId: string; ts: string }>
  >();
  for (const slot of states.values()) {
    for (const [target, claim] of slot.activeWriteClaims) {
      const list = claimants.get(target) ?? [];
      list.push({ slot, eventId: claim.eventId, ts: claim.ts });
      claimants.set(target, list);
    }
  }
  for (const list of claimants.values()) {
    if (list.length < 2) continue;
    const eventIds = list.map((claim) => claim.eventId).slice(-3);
    const newestTs = list.sort((a, b) => millis(b.ts) - millis(a.ts))[0]?.ts ?? now;
    for (const claim of list) {
      claim.slot.friction = {
        value: "target-contention",
        ts: newestTs,
        eventIds,
        ttlMs: CONTENTION_TTL_MS,
      };
    }
  }

  const nowMs = millis(now);
  const projected = new Map<string, CodecActivityChannels>();
  for (const [instanceId, slot] of states) {
    const open = newestOpen(slot);
    let operation: Presented<CodecOperationValue> | undefined;
    if (open) {
      const outputFresh =
        open.lastOutputTs !== undefined && nowMs - millis(open.lastOutputTs) <= OUTPUT_FLOW_TTL_MS;
      const elapsedMs = Number.isFinite(millis(open.ts))
        ? Math.max(0, nowMs - millis(open.ts))
        : undefined;
      const samples = durationBaselines.get(open.baselineKey) ?? [];
      const thresholdMs = longRunningThresholdMs(samples);
      const longRunning = open.orderReliable && elapsedMs !== undefined && elapsedMs > thresholdMs;
      const state = open.retryEvidenceIds
        ? "retrying"
        : outputFresh && (open.outputBytes > 0 || open.outputCount >= 2)
          ? "output-flow"
          : longRunning
            ? "long-running"
            : "active";
      const evidenceIds = [...(open.retryEvidenceIds ?? [open.eventId])];
      if (outputFresh && open.lastOutputTs) {
        const outputEvent = events.findLast(
          (event) =>
            event.instance_id === instanceId &&
            event.event_type === "command.output_observed" &&
            event.span_id === open.spanId,
        )?.event_id;
        if (outputEvent) evidenceIds.push(outputEvent);
      }
      operation = present(
        {
          category: open.category,
          label: open.label,
          state,
          ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
          duration_sample_count: samples.length,
          ...(Number.isFinite(thresholdMs) ? { long_running_threshold_ms: thresholdMs } : {}),
        },
        "event",
        "high",
        open.lastOutputTs ?? open.ts,
        evidenceIds,
      );
    } else if (slot.compaction) {
      const elapsedMs = Number.isFinite(millis(slot.compaction.ts))
        ? Math.max(0, nowMs - millis(slot.compaction.ts))
        : undefined;
      operation = present(
        {
          category: "other",
          label: "Compacting context",
          state: "active",
          ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
        },
        "event",
        "high",
        slot.compaction.ts,
        [slot.compaction.eventId],
      );
    }

    const artifactFresh =
      slot.artifact && nowMs - millis(slot.artifact.ts) <= ARTIFACT_TTL_MS
        ? slot.artifact
        : undefined;
    const frictionFresh =
      slot.friction && nowMs - millis(slot.friction.ts) <= slot.friction.ttlMs
        ? slot.friction
        : undefined;
    const telemetryFresh =
      slot.telemetry && nowMs - millis(slot.telemetry.ts) <= TELEMETRY_TTL_MS
        ? slot.telemetry
        : undefined;
    projected.set(instanceId, {
      ...(operation ? { operation } : {}),
      ...(artifactFresh
        ? {
            artifact_cue: present(
              artifactFresh.value,
              "event",
              "high",
              artifactFresh.ts,
              [artifactFresh.eventId],
              expiry(artifactFresh.ts, ARTIFACT_TTL_MS),
            ),
          }
        : {}),
      ...(frictionFresh
        ? {
            friction: present(
              frictionFresh.value,
              "inferred",
              frictionFresh.value === "target-contention" ? "high" : "medium",
              frictionFresh.ts,
              frictionFresh.eventIds,
              expiry(frictionFresh.ts, frictionFresh.ttlMs),
            ),
          }
        : {}),
      telemetry: telemetryFresh
        ? present(
            "degraded",
            "event",
            "high",
            telemetryFresh.ts,
            [telemetryFresh.eventId],
            expiry(telemetryFresh.ts, TELEMETRY_TTL_MS),
          )
        : present("unknown", "unknown", "low", now),
      ...(telemetryFresh
        ? {
            telemetry_reason: present(
              telemetryFresh.reason,
              "event",
              "high",
              telemetryFresh.ts,
              [telemetryFresh.eventId],
              expiry(telemetryFresh.ts, TELEMETRY_TTL_MS),
            ),
          }
        : {}),
    });
  }
  return projected;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

/** Conservative threshold learned from successful adapter/tool history. */
export function longRunningThresholdMs(samples: readonly number[]): number {
  if (samples.length < MIN_DURATION_SAMPLES) return Number.POSITIVE_INFINITY;
  return Math.max(LONG_RUNNING_FLOOR_MS, percentile(samples, 0.9) * LONG_RUNNING_MULTIPLIER);
}

export function unknownActivityChannels(now: string): Pick<CodecPanelScene, "telemetry"> {
  return { telemetry: present("unknown", "unknown", "low", now) };
}
