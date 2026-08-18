/**
 * TS implementation of the heartbeat-mutating actions. Replaces the previous
 * flock-serialized bash writes with atomic temp+rename in Bun. Phase 6 of the
 * agent-hooks/agent-coord refactor.
 *
 * Atomicity guarantee: every write goes via a `<path>.tmp.<pid>` sibling +
 * `renameSync`. POSIX rename is atomic within a filesystem, so concurrent
 * readers either see the pre-write file or the post-write file but never a
 * half-written intermediate. Concurrent writers serialize via the rename
 * (last write wins).
 *
 * Cache identity invariant: every action operates on the generation-bound row at
 * `.harnery/active/<instance_id>.json`; the canonical V2 ledger remains authoritative.
 * (the file IS the heartbeat). No mutations happen elsewhere.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentActivity, TaskState } from "./session-state.ts";

export interface Heartbeat {
  schema_version?: number;
  instance_id: string;
  name?: string;
  kind?: string;
  agent_id?: string;
  session_id: string;
  /** Native adapter session ID retained only in a generation-bound local projection. */
  native_session_id?: string;
  subagent_call_id?: string;
  model?: string;
  platform?: string;
  started_at?: string;
  last_heartbeat: string;
  files_touched: string[];
  task?: string;
  task_updated_at?: string | null;
  activity?: AgentActivity;
  activity_updated_at?: string;
  activity_source?: string;
  task_state?: TaskState;
  task_state_updated_at?: string;
  task_state_reason?: string;
  /** Session name built on the first non-empty set-task (never rebuilt). Its
   * presence is the "this session has been named" signal the prompt-context
   * nudge and the Stop-hook naming rule key on. */
  suggested_session_name?: string;
  /** Stamped by turn.completed once the suggested name is seen in assistant reply
   * text, ending the per-turn transcript scan. */
  session_name_seen_at?: string;
  /** WHICH name that sighting was for. The scan is skipped only while this
   * matches the current suggested name, so a re-minted name is detectable
   * again rather than being suppressed by the earlier sighting. */
  session_name_seen_for?: string;
  last_status_at?: string;
  current_turn_id?: string;
  parent_instance_id?: string;
  workflow_run_id?: string;
  workflow_agent_id?: string;
  /** Disposable-cache bindings that prove a row belongs to the current V3 generation. */
  v3_instance_id?: `inst_${string}`;
  v3_generation_id?: `gen_${string}`;
  v3_projection_event_id?: string;
  v3_task_state?: "set" | "cleared";
  [extra: string]: unknown;
}

function heartbeatPath(coordRoot: string, instanceId: string): string {
  return join(coordRoot, ".harnery", "active", `${instanceId}.json`);
}

function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function readHeartbeat(coordRoot: string, instanceId: string): Heartbeat | null {
  const path = heartbeatPath(coordRoot, instanceId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Heartbeat;
  } catch {
    return null;
  }
}

/** Persist operator-facing lifecycle prose in the generation-bound cache only. */
export function setLifecycleCache(
  coordRoot: string,
  instanceId: string,
  state: TaskState,
  reason?: string,
  suggestedSessionName?: string,
): Heartbeat | null {
  return mutate(coordRoot, instanceId, (heartbeat) => ({
    ...heartbeat,
    task_state: state,
    task_state_updated_at: nowIsoSeconds(),
    task_state_reason: state === "active" ? undefined : reason,
    ...(suggestedSessionName ? { suggested_session_name: suggestedSessionName } : {}),
  }));
}

function mutate(
  coordRoot: string,
  instanceId: string,
  fn: (hb: Heartbeat) => Heartbeat,
): Heartbeat | null {
  const hb = readHeartbeat(coordRoot, instanceId);
  if (!hb) return null;
  const next = fn(hb);
  next.last_heartbeat = nowIsoSeconds();
  atomicWrite(heartbeatPath(coordRoot, instanceId), JSON.stringify(next, null, 2));
  return next;
}

export function setTask(coordRoot: string, instanceId: string, task: string): Heartbeat | null {
  return mutate(coordRoot, instanceId, (hb) => {
    const cleared = !task || task.length === 0;
    // Name the session on its first NON-EMPTY declaration. Keyed on the
    // suggested_session_name stamp, not task_updated_at, so a bare clear as
    // the first call never burns the naming window. Subagents and workflow
    // children have no human-owned tab to rename, so they are never named.
    const humanFacing = hb.kind !== "subagent" && hb.kind !== "transient" && !hb.workflow_run_id;
    const built =
      !cleared && !hb.suggested_session_name && humanFacing
        ? buildSuggestedName(hb.name ?? "unknown", [task])
        : null;
    return {
      ...hb,
      task: cleared ? undefined : task,
      task_updated_at: nowIsoSeconds(),
      ...(hb.schema_version === 2 ? { v3_task_state: cleared ? "cleared" : "set" } : {}),
      ...(built ? { suggested_session_name: built.suggestedName } : {}),
    };
  });
}

/** Update the disposable identity cache after a canonical V2 attestation. */
export function setIdentityCache(
  coordRoot: string,
  instanceId: string,
  name: string,
  agentId: string,
): Heartbeat | null {
  const heartbeat = readHeartbeat(coordRoot, instanceId);
  if (!heartbeat) return null;
  heartbeat.name = name;
  heartbeat.agent_id = agentId;
  atomicWrite(heartbeatPath(coordRoot, instanceId), JSON.stringify(heartbeat, null, 2));
  return heartbeat;
}

/**
 * Build the copy-pasteable session name from the coord identity + the agent's
 * description parts. Pure (no coord-state reads) so it's unit-testable; collapses
 * internal whitespace and trims. Returns null when the description is empty.
 */
export function buildSuggestedName(
  agentName: string,
  descriptionParts: string[],
): { suggestedName: string; description: string } | null {
  const description = descriptionParts.join(" ").replace(/\s+/g, " ").trim();
  if (!description) return null;
  const name = agentName?.trim() || "unknown";
  return { suggestedName: `Agent ${name} - ${description}`, description };
}

/** Build the operator-facing title projected from an explicit task lifecycle. */
export function buildLifecycleSuggestedName(
  agentName: string,
  task: string | undefined,
  state: TaskState,
): string | null {
  const built = buildSuggestedName(agentName, task ? [task] : []);
  if (!built) return null;
  if (state === "blocked") return `[BLOCKED] - ${built.suggestedName}`;
  if (state === "done") return `[DONE] - ${built.suggestedName}`;
  return built.suggestedName;
}

/** Stamp the sighting once the suggested name has been observed in assistant
 * reply text; later turns skip the transcript scan. Records WHICH name was seen,
 * because the skip is only valid for that one: if a later set-task mints a
 * different suggested name, a bare "already seen" stamp would suppress the scan
 * forever and leave the Stop-hook naming rule permanently unsatisfiable. */
export function stampSessionNameSeen(
  coordRoot: string,
  instanceId: string,
  name?: string,
): Heartbeat | null {
  return mutate(coordRoot, instanceId, (hb) => ({
    ...hb,
    session_name_seen_at: hb.session_name_seen_at ?? nowIsoSeconds(),
    ...(name ? { session_name_seen_for: name } : {}),
  }));
}

export function releaseClaim(
  coordRoot: string,
  instanceId: string,
  path: string,
): Heartbeat | null {
  // files_touched can hold either absolute-under-coordRoot or canonical
  // monorepo-relative entries; normalize both sides so release matches
  // regardless of the form the caller passes (the old exact-string filter
  // silently no-op'd on a form mismatch).
  const norm = (p: string): string =>
    p.startsWith(`${coordRoot}/`) ? p.slice(coordRoot.length + 1) : p;
  const target = norm(path);
  return mutate(coordRoot, instanceId, (hb) => ({
    ...hb,
    files_touched: (hb.files_touched ?? []).filter((p) => norm(p) !== target),
  }));
}

/** Materialize one V2 write-claim authority transition into the heartbeat cache. */
export function acquireClaim(
  coordRoot: string,
  instanceId: string,
  path: string,
): Heartbeat | null {
  const norm = (p: string): string =>
    p.startsWith(`${coordRoot}/`) ? p.slice(coordRoot.length + 1) : p;
  const target = norm(path);
  return mutate(coordRoot, instanceId, (hb) => ({
    ...hb,
    files_touched: [...new Set([...(hb.files_touched ?? []).map(norm), target])].sort(),
  }));
}

/** A heartbeat that actually dropped a path during a group unclaim. */
export interface GroupUnclaimHit {
  instance_id: string;
  session_id?: string;
  platform?: string;
}

/**
 * Session-group-wide unclaim. Walks every heartbeat sharing `groupId`
 * (parent's session_id == group_id;
 * subagents inherit it) and removes the path from each one's files_touched.
 * Idempotent: heartbeats that don't hold the path are untouched. Returns the
 * heartbeats that actually dropped the path so the caller can emit the
 * durable `coord.claim_changed` release events; a file-only prune is silently reverted by
 * the next projector replay.
 *
 * Tool payloads and release calls can supply either absolute-under-coordRoot or
 * canonical repo-relative entries, so both sides are normalized before comparing. An exact-string match
 * silently no-ops on the mixed-form case and the claim never releases.
 *
 * This is the Option B fix for post-commit's pid-map attribution hole: a
 * subagent-held claim that doesn't live on the parent's heartbeat still gets
 * pruned because the walk covers the whole group.
 */
export function findGroupClaims(
  coordRoot: string,
  groupId: string,
  path: string,
): GroupUnclaimHit[] {
  const hits: GroupUnclaimHit[] = [];
  if (!groupId || !path) return hits;
  const activeDir = join(coordRoot, ".harnery", "active");
  if (!existsSync(activeDir)) return hits;
  const norm = (p: string): string =>
    p.startsWith(`${coordRoot}/`) ? p.slice(coordRoot.length + 1) : p;
  const target = norm(path);
  for (const f of readdirSync(activeDir)) {
    if (!f.endsWith(".json")) continue;
    const hbPath = join(activeDir, f);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(readFileSync(hbPath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const peerSession =
      (body.session_id as string | undefined) ?? (body.instance_id as string | undefined);
    if (peerSession !== groupId) continue;
    const files = (body.files_touched as string[] | undefined) ?? [];
    if (!files.some((candidate) => norm(candidate) === target)) continue;
    hits.push({
      instance_id: (body.instance_id as string | undefined) ?? f.replace(/\.json$/, ""),
      session_id: body.session_id as string | undefined,
      platform: body.platform as string | undefined,
    });
  }
  return hits;
}

export function clearCoordinationCache(coordRoot: string, instanceId: string): boolean {
  const path = heartbeatPath(coordRoot, instanceId);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export function healPidmap(coordRoot: string, instanceId: string, pid: number): void {
  const dir = join(coordRoot, ".harnery", "pid-map");
  mkdirSync(dir, { recursive: true });
  const hb = readHeartbeat(coordRoot, instanceId);
  const platform = hb?.platform ?? "claude-code";
  const pmPath = join(dir, String(pid));
  // Drift guard: only write + emit telemetry when the entry is missing or
  // points at a different owner. Without this, a per-tool-call heal would
  // flood health.pidmap_heal on every call.
  let existingOwner = "";
  try {
    if (existsSync(pmPath)) existingOwner = readFileSync(pmPath, "utf8").split("\t")[0] ?? "";
  } catch {
    /* treat as missing */
  }
  if (existingOwner === instanceId) return;
  atomicWrite(pmPath, `${instanceId}\t${platform}`);
}
