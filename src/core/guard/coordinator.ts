import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEventV3ControlState } from "../events/v3/control.ts";
import { liveInstanceIdV3 } from "../events/v3/live-routing.ts";
import { readRunQualityConfig } from "./config.ts";
import { evaluateRunQuality } from "./evaluator.ts";
import { readRunQualityLiveSourceV3 } from "./live-source-v3.ts";
import {
  acquireEvaluationLock,
  cleanupOrphanSnapshots,
  evaluationLockOwned,
  guardDir,
  readGuardCursor,
  readRunQualitySnapshot,
  releaseEvaluationLock,
  writeAtomicJson,
  writeGuardCursor,
  writeRunQualitySnapshot,
} from "./storage.ts";
import type { RunQualityConfigResult, RunQualitySnapshot } from "./types.ts";

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
  const canonicalInstanceId = instanceId ? liveInstanceIdV3(instanceId) : undefined;
  const previousForCaller = canonicalInstanceId
    ? readRunQualitySnapshot(coordRoot, canonicalInstanceId)
    : null;
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
    const control = readEventV3ControlState(coordRoot);
    if (control.state !== "candidate" && control.state !== "active") {
      throw new Error(`run_quality_v3_control_${control.state}`);
    }
    return evaluateRunQualityV3({
      coordRoot,
      now,
      instanceId: canonicalInstanceId,
      configResult,
      deadline,
      lockNonce: lock.nonce,
    });
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

function evaluateRunQualityV3(input: {
  coordRoot: string;
  now: Date;
  instanceId?: string;
  configResult: Extract<RunQualityConfigResult, { valid: true }> | RunQualityConfigResult;
  deadline: number;
  lockNonce: string;
}): RunQualityEvaluationResult {
  const config = input.configResult.config;
  if (!config) throw new Error("run_quality_v3_config_unavailable");
  const source = readRunQualityLiveSourceV3(input.coordRoot, input.now);
  const snapshots: RunQualitySnapshot[] = [];
  for (const generation of source.generations) {
    const previous = readRunQualitySnapshot(input.coordRoot, generation.instance_id) ?? undefined;
    const previousIndex = previous?.evidence.last_event_id
      ? generation.events.findIndex((event) => event.event_id === previous.evidence.last_event_id)
      : -1;
    const events =
      previousIndex >= 0 ? generation.events.slice(previousIndex + 1) : generation.events;
    const snapshot = evaluateRunQuality({
      instance_id: generation.instance_id,
      session_id: generation.session_id,
      session_generation: generation.generation_id,
      adapter: generation.adapter,
      now: input.now.toISOString(),
      config,
      config_digest: input.configResult.digest,
      events,
      previous,
      role_wait: generation.role_wait,
      evidence: generation.evidence,
      sufficient_history:
        generation.sufficient_history &&
        (!previous ||
          previous.session_generation !== generation.generation_id ||
          previousIndex >= 0),
      live: true,
    });
    snapshots.push(snapshot);
  }

  assertCanPublish(input.coordRoot, input.lockNonce, input.deadline);
  const liveIds = new Set(snapshots.map((snapshot) => snapshot.instance_id));
  for (const snapshot of snapshots) {
    assertCanPublish(input.coordRoot, input.lockNonce, input.deadline);
    writeRunQualitySnapshot(input.coordRoot, snapshot, input.lockNonce);
  }
  cleanupOrphanSnapshots(input.coordRoot, liveIds);

  const last = source.generations
    .flatMap((generation) => generation.events)
    .sort(
      (left, right) =>
        left.ts.localeCompare(right.ts) || left.event_id.localeCompare(right.event_id),
    )
    .at(-1);
  writeGuardCursor(
    input.coordRoot,
    {
      schema_version: 1,
      segment: last ? `v3:${source.genesis_id}` : `v3:${source.genesis_id}:empty`,
      last_event_id: last?.event_id,
      next_eligible_at: new Date(
        input.now.getTime() + config.evaluation_interval_seconds * 1000,
      ).toISOString(),
      config_digest: input.configResult.digest,
      updated_at: input.now.toISOString(),
    },
    input.lockNonce,
  );

  return {
    config: input.configResult,
    evaluated: true,
    busy: false,
    timed_out: false,
    snapshot: input.instanceId
      ? (snapshots.find((snapshot) => snapshot.instance_id === input.instanceId) ?? null)
      : null,
  };
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
  mkdirSync(dir, { recursive: true });
  writeAtomicJson(
    markerPath,
    { digest: config.digest, emitted_at: now.toISOString() },
    config.digest,
  );
}

function assertCanPublish(coordRoot: string, nonce: string, deadline: number): void {
  if (Date.now() > deadline) throw new Error("run_quality_evaluation_timeout");
  if (!evaluationLockOwned(coordRoot, nonce)) throw new Error("run_quality_lock_stolen");
}
