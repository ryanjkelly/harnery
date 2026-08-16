import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { emit } from "../agents/events/emit.ts";
import type { Heartbeat } from "../agents/index.ts";
import { coordFreshnessSeconds } from "../config.ts";
import { readRunQualityConfig } from "./config.ts";
import { evaluateRunQuality } from "./evaluator.ts";
import { resolveRunQualityRoleWait } from "./role-wait.ts";
import {
  acquireEvaluationLock,
  type CanonicalGuardEvent,
  cleanupOrphanSnapshots,
  evaluationLockOwned,
  type GuardCursor,
  guardDir,
  readGuardCursor,
  readGuardEventWindow,
  readRunQualitySnapshot,
  releaseEvaluationLock,
  writeAtomicJson,
  writeGuardCursor,
  writeRunQualitySnapshot,
} from "./storage.ts";
import type {
  RunQualityConfigResult,
  RunQualityEvidenceEvent,
  RunQualitySnapshot,
} from "./types.ts";

export interface RunQualityEvaluationResult {
  config: RunQualityConfigResult;
  evaluated: boolean;
  busy: boolean;
  timed_out: boolean;
  snapshot: RunQualitySnapshot | null;
}

/**
 * Lazy, root-scoped evaluator. Its due check is config/cursor-only; ledger I/O
 * begins only after the non-blocking writer lock is acquired.
 */
export function evaluateRunQualityIfDue(
  coordRoot: string,
  now: Date = new Date(),
  instanceId?: string,
): RunQualityEvaluationResult {
  const configResult = readRunQualityConfig(coordRoot);
  const previousForCaller = instanceId ? readRunQualitySnapshot(coordRoot, instanceId) : null;
  if (!configResult.valid || !configResult.config) {
    maybeEmitInvalidConfig(coordRoot, configResult, now);
    return {
      config: configResult,
      evaluated: false,
      busy: false,
      timed_out: false,
      snapshot: null,
    };
  }
  const config = configResult.config;
  if (config.mode === "off") {
    return {
      config: configResult,
      evaluated: false,
      busy: false,
      timed_out: false,
      snapshot: previousForCaller,
    };
  }

  const cursor = readGuardCursor(coordRoot);
  if (
    cursor?.config_digest === configResult.digest &&
    Date.parse(cursor.next_eligible_at) > now.getTime()
  ) {
    return {
      config: configResult,
      evaluated: false,
      busy: false,
      timed_out: false,
      snapshot: previousForCaller,
    };
  }

  const lock = acquireEvaluationLock(coordRoot, now, config.lock_stale_seconds);
  if (!lock) {
    return {
      config: configResult,
      evaluated: false,
      busy: true,
      timed_out: false,
      snapshot: previousForCaller,
    };
  }

  const deadline = Date.now() + config.evaluation_timeout_seconds * 1000;
  let timedOut = false;
  try {
    const heartbeats = readLiveHeartbeats(coordRoot, now);
    const liveIds = new Set(heartbeats.map((heartbeat) => heartbeat.instance_id));
    const window = readGuardEventWindow(coordRoot, config.max_tail_bytes);
    assertCanPublish(coordRoot, lock.nonce, deadline);

    const exactCursorIndex = cursor?.last_event_id
      ? window.events.findIndex(
          (event) => event.event_id === cursor.last_event_id && event.segment === cursor.segment,
        )
      : -1;
    const relocatedCursorIndex =
      exactCursorIndex < 0 && cursor?.last_event_id
        ? window.events.findIndex((event) => event.event_id === cursor.last_event_id)
        : -1;
    const cursorIndex = exactCursorIndex >= 0 ? exactCursorIndex : relocatedCursorIndex;
    const gap = !!cursor?.last_event_id && cursorIndex < 0;
    const newEvents =
      cursor?.last_event_id && cursorIndex >= 0
        ? window.events.slice(cursorIndex + 1)
        : window.events;
    const snapshots: RunQualitySnapshot[] = [];

    for (const heartbeat of heartbeats) {
      const previous = readRunQualitySnapshot(coordRoot, heartbeat.instance_id) ?? undefined;
      const rawForInstance = newEvents.filter(
        (event) =>
          event.instance_id === heartbeat.instance_id && isRunQualityEvidenceType(event.event_type),
      );
      const allForInstance = window.events.filter(
        (event) => event.instance_id === heartbeat.instance_id,
      );
      const generationEvent = [...allForInstance]
        .reverse()
        .find(
          (event) =>
            event.event_type === "session.start" && event.session_id === heartbeat.session_id,
        );
      const generation =
        generationEvent?.event_id ??
        (previous?.session_id === heartbeat.session_id
          ? previous.session_generation
          : fallbackGeneration(heartbeat));
      const sameGeneration = previous?.session_generation === generation;
      const hasSessionStart = !!generationEvent;
      const sufficientHistory =
        (!gap && sameGeneration && !!previous) || (!gap && !window.truncated && hasSessionStart);
      const first = rawForInstance[0];
      const last = rawForInstance.at(-1);
      const evidence = {
        first_event_id: previous?.evidence.first_event_id ?? first?.event_id,
        last_event_id: last?.event_id ?? previous?.evidence.last_event_id,
        window_started_at: previous?.evidence.window_started_at ?? first?.ts,
        window_ended_at: last?.ts ?? previous?.evidence.window_ended_at,
        segment: last?.segment ?? previous?.evidence.segment ?? window.segment,
        truncated: gap || (!previous && window.truncated),
      };
      const snapshot = evaluateRunQuality({
        instance_id: heartbeat.instance_id,
        session_id: heartbeat.session_id,
        session_generation: generation,
        adapter: normalizeAdapter(heartbeat.platform),
        now: now.toISOString(),
        config,
        config_digest: configResult.digest,
        events: normalizeEvidence(rawForInstance),
        previous,
        role_wait: resolveRunQualityRoleWait(
          coordRoot,
          heartbeat,
          window.events,
          now.toISOString(),
        ),
        evidence,
        sufficient_history: sufficientHistory,
        live: true,
      });
      snapshots.push(snapshot);
    }

    assertCanPublish(coordRoot, lock.nonce, deadline);
    for (const snapshot of snapshots) {
      assertCanPublish(coordRoot, lock.nonce, deadline);
      writeRunQualitySnapshot(coordRoot, snapshot, lock.nonce);
    }
    cleanupOrphanSnapshots(coordRoot, liveIds);

    const lastGlobal = window.events.at(-1);
    const nextCursor: GuardCursor = {
      schema_version: 1,
      segment: lastGlobal?.segment ?? cursor?.segment ?? window.segment,
      last_event_id: lastGlobal?.event_id ?? cursor?.last_event_id,
      next_eligible_at: new Date(
        now.getTime() + config.evaluation_interval_seconds * 1000,
      ).toISOString(),
      config_digest: configResult.digest,
      updated_at: now.toISOString(),
    };
    assertCanPublish(coordRoot, lock.nonce, deadline);
    writeGuardCursor(coordRoot, nextCursor, lock.nonce);

    for (const snapshot of snapshots) emitTransition(coordRoot, snapshot);
    return {
      config: configResult,
      evaluated: true,
      busy: false,
      timed_out: false,
      snapshot: instanceId
        ? (snapshots.find((snapshot) => snapshot.instance_id === instanceId) ?? null)
        : null,
    };
  } catch (error) {
    timedOut = (error as Error).message === "run_quality_evaluation_timeout";
    return {
      config: configResult,
      evaluated: false,
      busy: false,
      timed_out: timedOut,
      snapshot: previousForCaller,
    };
  } finally {
    releaseEvaluationLock(coordRoot, lock.nonce);
  }
}

function normalizeEvidence(events: CanonicalGuardEvent[]): RunQualityEvidenceEvent[] {
  return events.flatMap((event): RunQualityEvidenceEvent[] => {
    const data = event.data;
    switch (event.event_type) {
      case "tool.pre_use":
        return [
          {
            event_id: event.event_id,
            ts: event.ts,
            kind: "tool_call",
            input_hash: stringValue(data.input_hash),
            target_hash: stringValue(data.target_hash),
          },
        ];
      case "tool.post_use": {
        const rows: RunQualityEvidenceEvent[] = [
          {
            event_id: event.event_id,
            ts: event.ts,
            kind: data.exit_status === "error" ? "tool_failure" : "tool_success",
          },
        ];
        if (data.exit_status !== "error" && progressTool(stringValue(data.tool_name))) {
          rows.push({ event_id: `${event.event_id}:progress`, ts: event.ts, kind: "progress" });
        }
        return rows;
      }
      case "tool.post_use_failure":
        return [{ event_id: event.event_id, ts: event.ts, kind: "tool_failure" }];
      case "claim.acquire":
        return data.mode === "write"
          ? [{ event_id: event.event_id, ts: event.ts, kind: "progress" }]
          : [];
      case "user_prompt.submit":
        return [{ event_id: event.event_id, ts: event.ts, kind: "progress" }];
      case "context.sampled":
        return [
          {
            event_id: event.event_id,
            ts: event.ts,
            kind: "context_sample",
            used_tokens: numberValue(data.used_tokens),
            confidence: confidenceValue(data.confidence),
            telemetry_source: stringValue(data.telemetry_source),
          },
        ];
      case "context.compaction.started":
        return [{ event_id: event.event_id, ts: event.ts, kind: "compaction_started" }];
      case "context.compaction.completed":
        return [{ event_id: event.event_id, ts: event.ts, kind: "compaction_completed" }];
      default:
        return [];
    }
  });
}

function emitTransition(coordRoot: string, snapshot: RunQualitySnapshot): void {
  if (snapshot.status === snapshot.previous_status && snapshot.reason !== "config_changed") return;
  const signalIds = snapshot.signals
    .filter((signal) => signal.state === "active")
    .map((signal) => signal.id)
    .sort()
    .slice(0, 8);
  emit(coordRoot, {
    event_type: "health.run_quality_changed",
    instance_id: snapshot.instance_id,
    session_id: snapshot.session_id,
    adapter: normalizeAdapter(snapshot.adapter),
    source: "agent-coord",
    data: {
      previous_status: snapshot.previous_status,
      status: snapshot.status,
      signal_ids: signalIds,
      evidence_watermark: snapshot.evidence.last_event_id,
      reason: snapshot.reason,
    },
  });
}

function maybeEmitInvalidConfig(
  coordRoot: string,
  config: RunQualityConfigResult,
  now: Date,
): void {
  if (config.valid) return;
  const dir = guardDir(coordRoot);
  const markerPath = join(dir, "config-invalid.json");
  let previousDigest: string | undefined;
  try {
    previousDigest = (JSON.parse(readFileSync(markerPath, "utf8")) as { digest?: string }).digest;
  } catch {
    // First invalid observation.
  }
  if (previousDigest === config.digest) return;
  const heartbeat = readLiveHeartbeats(coordRoot, now)[0];
  emit(coordRoot, {
    event_type: "health.run_quality_config_invalid",
    instance_id: heartbeat?.instance_id ?? "run-quality",
    session_id: heartbeat?.session_id ?? "run-quality",
    adapter: normalizeAdapter(heartbeat?.platform),
    source: "agent-coord",
    data: {
      config_digest: config.digest,
      reason_codes: config.reason_codes.slice(0, 12),
      fallback: "off",
    },
  });
  mkdirSync(dir, { recursive: true });
  writeAtomicJson(
    markerPath,
    { digest: config.digest, emitted_at: now.toISOString() },
    config.digest,
  );
}

function readLiveHeartbeats(coordRoot: string, now: Date): Heartbeat[] {
  const dir = join(coordRoot, ".harnery", "active");
  if (!existsSync(dir)) return [];
  const cutoff = now.getTime() - coordFreshnessSeconds(coordRoot) * 1000;
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name): Heartbeat[] => {
      const path = join(dir, name);
      try {
        if (statSync(path).size > 1024 * 1024) return [];
        const heartbeat = JSON.parse(readFileSync(path, "utf8")) as Heartbeat;
        const observedAt = Date.parse(heartbeat.last_heartbeat);
        return heartbeat?.instance_id &&
          heartbeat?.session_id &&
          Number.isFinite(observedAt) &&
          observedAt >= cutoff
          ? [heartbeat]
          : [];
      } catch {
        return [];
      }
    });
}

function assertCanPublish(coordRoot: string, nonce: string, deadline: number): void {
  if (Date.now() > deadline) throw new Error("run_quality_evaluation_timeout");
  if (!evaluationLockOwned(coordRoot, nonce)) throw new Error("run_quality_lock_stolen");
}

function fallbackGeneration(heartbeat: Heartbeat): string {
  return createHash("sha256")
    .update(heartbeat.session_id)
    .update("\n")
    .update(heartbeat.started_at ?? "unknown")
    .digest("hex")
    .slice(0, 26);
}

function normalizeAdapter(value: unknown): "claude-code" | "cursor" | "codex" {
  if (value === "cursor") return "cursor";
  if (value === "codex") return "codex";
  return "claude-code";
}

function progressTool(toolName: string | undefined): boolean {
  return (
    !!toolName && /^(Edit|Write|NotebookEdit|MultiEdit|StrReplace|apply_patch)$/i.test(toolName)
  );
}

function isRunQualityEvidenceType(eventType: string): boolean {
  return (
    eventType.startsWith("tool.") ||
    eventType === "claim.acquire" ||
    eventType === "user_prompt.submit" ||
    eventType === "context.sampled" ||
    eventType === "context.compaction.started" ||
    eventType === "context.compaction.completed"
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function confidenceValue(value: unknown): RunQualityEvidenceEvent["confidence"] {
  return value === "exact" || value === "reported" || value === "estimated" ? value : undefined;
}
