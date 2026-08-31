import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  SUPERVISOR_ACTIVITY_SCHEMA_VERSION,
  SUPERVISOR_DIAGNOSTIC_LIMITS,
  SUPERVISOR_FINDING_POLICY,
  type SupervisorActivitySnapshot,
  type SupervisorDeclaredActivity,
  type SupervisorSourceReference,
} from "./contract.ts";

interface ActivityCache {
  schema_version?: number;
  instance_id?: string;
  session_id?: string;
  activity?: string;
  task_state?: string;
  last_heartbeat?: string;
  v3_instance_id?: string;
  v3_generation_id?: string;
}

interface CandidateFile {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

/** Read a bounded, generation-bound activity projection without loading Event Ledger V3. */
export function collectSupervisorActivitySnapshot(
  coordRoot: string,
  now = new Date(),
): SupervisorActivitySnapshot {
  const observedAt = now.toISOString();
  const directory = join(resolve(coordRoot), ".harnery", "active");
  if (!existsSync(directory)) return unavailable(observedAt, "activity-projection-missing");

  const candidates: CandidateFile[] = [];
  let rejected = 0;
  try {
    for (const entry of readdirSync(directory)) {
      if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(entry)) {
        rejected += 1;
        continue;
      }
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size < 2 ||
        stat.size > SUPERVISOR_FINDING_POLICY.max_activity_file_bytes
      ) {
        rejected += 1;
        continue;
      }
      candidates.push({ name: entry.slice(0, -5), path, bytes: stat.size, mtimeMs: stat.mtimeMs });
    }
  } catch {
    return unavailable(observedAt, "activity-projection-read-failed", "error");
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
  const entries: SupervisorDeclaredActivity[] = [];
  let totalBytes = 0;
  let stale = 0;
  for (const candidate of candidates) {
    if (
      entries.length >= SUPERVISOR_DIAGNOSTIC_LIMITS.max_activity_entries ||
      totalBytes + candidate.bytes > SUPERVISOR_FINDING_POLICY.max_activity_total_bytes
    ) {
      rejected += 1;
      continue;
    }
    totalBytes += candidate.bytes;
    let cache: ActivityCache;
    try {
      cache = JSON.parse(readFileSync(candidate.path, "utf8")) as ActivityCache;
    } catch {
      rejected += 1;
      continue;
    }
    if (!validCache(cache, candidate.name)) {
      rejected += 1;
      continue;
    }
    const age = now.getTime() - Date.parse(cache.last_heartbeat!);
    if (!Number.isFinite(age) || age < -30_000 || age > SUPERVISOR_FINDING_POLICY.activity_freshness_ms) {
      stale += 1;
      continue;
    }
    entries.push(activityEntry(cache as Required<ActivityCache>));
  }

  const state = rejected > 0 ? "partial" : "supported";
  return {
    schema_version: SUPERVISOR_ACTIVITY_SCHEMA_VERSION,
    observed_at: observedAt,
    max_entries: SUPERVISOR_DIAGNOSTIC_LIMITS.max_activity_entries,
    entries: entries.sort((left, right) => left.scope_id.localeCompare(right.scope_id)),
    omitted_entry_count: rejected + stale,
    capability: {
      source_kind: "coordination.activity-projection",
      state,
      ...(state === "partial" ? { reason_code: "bounded-cache-rejection" } : {}),
      ...(rejected + stale > 0
        ? { detail: `${rejected} invalid or over-budget and ${stale} stale activity rows omitted.` }
        : {}),
    },
  };
}

function validCache(cache: ActivityCache, fileId: string): boolean {
  return (
    cache.schema_version === 2 &&
    cache.instance_id === fileId &&
    typeof cache.session_id === "string" &&
    cache.session_id.length > 0 &&
    isActivity(cache.activity) &&
    isTaskState(cache.task_state) &&
    typeof cache.last_heartbeat === "string" &&
    typeof cache.v3_instance_id === "string" &&
    cache.v3_instance_id.startsWith("inst_") &&
    typeof cache.v3_generation_id === "string" &&
    cache.v3_generation_id.startsWith("gen_")
  );
}

function activityEntry(cache: Required<ActivityCache>): SupervisorDeclaredActivity {
  const source = activitySource(cache);
  return {
    scope_kind: "agent",
    scope_id: cache.instance_id,
    session_id: cache.session_id,
    declared_activity: cache.activity as SupervisorDeclaredActivity["declared_activity"],
    task_state: cache.task_state as SupervisorDeclaredActivity["task_state"],
    observed_at: cache.last_heartbeat,
    source,
  };
}

function activitySource(cache: Required<ActivityCache>): SupervisorSourceReference {
  const sourceId = `${cache.v3_instance_id}:${cache.v3_generation_id}`;
  return {
    id: `src_${digest(`coordination.activity-projection\u0000${sourceId}\u0000${cache.last_heartbeat}`).slice(0, 24)}`,
    source_kind: "coordination.activity-projection",
    source_id: sourceId,
    observed_at: cache.last_heartbeat,
    schema_version: SUPERVISOR_ACTIVITY_SCHEMA_VERSION,
    capability: "supported",
  };
}

function unavailable(
  observedAt: string,
  reasonCode: string,
  state: "unsupported" | "error" = "unsupported",
): SupervisorActivitySnapshot {
  return {
    schema_version: SUPERVISOR_ACTIVITY_SCHEMA_VERSION,
    observed_at: observedAt,
    max_entries: SUPERVISOR_DIAGNOSTIC_LIMITS.max_activity_entries,
    entries: [],
    omitted_entry_count: 0,
    capability: {
      source_kind: "coordination.activity-projection",
      state,
      reason_code: reasonCode,
    },
  };
}

function isActivity(value: string | undefined): value is SupervisorDeclaredActivity["declared_activity"] {
  return value === "working" || value === "needs_input" || value === "idle" || value === "unknown";
}

function isTaskState(value: string | undefined): value is SupervisorDeclaredActivity["task_state"] {
  return value === "active" || value === "blocked" || value === "done";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
