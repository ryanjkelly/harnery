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
 * Owner identity invariant: every action operates on `.harnery/active/<instance_id>.json`
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
import { emit } from "../events/emit.ts";
import {
  type AgentActivity,
  applySessionStateEvent,
  type SessionStateEvidenceEvent,
  type TaskState,
} from "./session-state.ts";

/** Inline adapter normalizer (mirrors canonical-emit.normalizeAdapter), kept
 * local so the writer's only cross-module dep is the in-process emit(). */
function adapterOf(platform: string | undefined): "claude-code" | "cursor" | "codex" {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return "claude-code";
}

/** Preserve the canonical adapter id in heartbeat state. Mirrors
 * heartbeat-projector.adapterToPlatform so a healed heartbeat carries the same
 * platform value projection would have written. */
function adapterToPlatform(adapter: string | undefined): string {
  if (adapter === "cursor") return "cursor";
  if (adapter === "codex") return "codex";
  return "claude-code";
}

/**
 * Emit a canonical `health.*` event for an actual self-heal write. This is the
 * single source of truth for heal telemetry across BOTH the live auto-heal
 * (the pre-tool-use hook → agent-coord heal-heartbeat) and the manual `harn agents
 * heal` path. Write-only by construction (callers only invoke it after a real
 * write), so an already-correct heal records nothing.
 * Best-effort: never throws into the heal path.
 */
function emitHealthHeal(
  coordRoot: string,
  type: "health.pidmap_heal" | "health.heartbeat_heal",
  instanceId: string,
  hb: Heartbeat | null,
  data: Record<string, unknown>,
): void {
  try {
    emit(coordRoot, {
      event_type: type,
      instance_id: instanceId,
      session_id: hb?.session_id ?? instanceId,
      adapter: adapterOf(hb?.platform),
      source: "agent-coord",
      data,
    });
  } catch {
    /* telemetry only, never break a heal */
  }
}

export interface Heartbeat {
  schema_version?: number;
  instance_id: string;
  name?: string;
  kind?: string;
  agent_id?: string;
  session_id: string;
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
  /** Stamped by turn.stop once the suggested name is seen in assistant reply
   * text, ending the per-turn transcript scan. */
  session_name_seen_at?: string;
  /** WHICH name that sighting was for. The scan is skipped only while this
   * matches the current suggested name, so a re-minted name is detectable
   * again rather than being suppressed by the earlier sighting. */
  session_name_seen_for?: string;
  last_status_at?: string;
  turn_summary?: string | null;
  turn_summary_updated_at?: string | null;
  last_tool?: string;
  last_tool_target?: string;
  last_tool_at?: string;
  current_turn_id?: string;
  parent_instance_id?: string;
  workflow_run_id?: string;
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

/** Apply one evidence event to the live state fields without draining the
 * global event stream. This keeps permission prompts current while avoiding
 * unrelated projector side effects before a tool authorization verdict. */
export function stampSessionStateEvent(
  coordRoot: string,
  instanceId: string,
  event: Omit<SessionStateEvidenceEvent, "data"> & { data: unknown },
): Heartbeat | null {
  return mutate(coordRoot, instanceId, (heartbeat) => {
    const data =
      typeof event.data === "object" && event.data !== null && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : {};
    const state = applySessionStateEvent(heartbeat, { ...event, data });
    return {
      ...heartbeat,
      activity: state.activity,
      activity_updated_at: state.activity_updated_at,
      activity_source: state.activity_source,
      task_state: state.task_state,
      task_state_updated_at: state.task_state_updated_at,
      task_state_reason: state.task_state_reason,
    };
  });
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
      ...(built ? { suggested_session_name: built.suggestedName } : {}),
    };
  });
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

export function setTurnSummary(
  coordRoot: string,
  instanceId: string,
  summary: string,
): Heartbeat | null {
  return mutate(coordRoot, instanceId, (hb) => ({
    ...hb,
    turn_summary: summary,
    turn_summary_updated_at: nowIsoSeconds(),
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
 * durable `claim.release` events — a file-only prune is silently reverted by
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
export function groupUnclaim(coordRoot: string, groupId: string, path: string): GroupUnclaimHit[] {
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
    const next = files.filter((p) => norm(p) !== target);
    if (next.length === files.length) continue;
    body.files_touched = next;
    try {
      const tmp = `${hbPath}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
      renameSync(tmp, hbPath);
      hits.push({
        instance_id: (body.instance_id as string | undefined) ?? f.replace(/\.json$/, ""),
        session_id: body.session_id as string | undefined,
        platform: body.platform as string | undefined,
      });
    } catch {
      /* silent */
    }
  }
  return hits;
}

export function killHeartbeat(coordRoot: string, instanceId: string): boolean {
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
  emitHealthHeal(coordRoot, "health.pidmap_heal", instanceId, hb, {
    reason: existingOwner ? "stale" : "missing",
    pid,
    kind: "pidmap",
    ...(existingOwner ? { prior: existingOwner.slice(0, 8) } : {}),
  });
}

export function healHeartbeat(
  coordRoot: string,
  instanceId: string,
  sessionId?: string,
  model?: string,
  adapter?: string,
  opts?: { forkedFrom?: string },
): Heartbeat | null {
  const path = heartbeatPath(coordRoot, instanceId);
  if (existsSync(path)) {
    // Already alive, return it.
    return readHeartbeat(coordRoot, instanceId);
  }
  const now = nowIsoSeconds();

  // Recover name + kind from .name-history if present (idempotent across
  // sweeps: same instance_id always gets the same name).
  let name = "";
  let kind = "session";
  let agentId = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const names = require("./names.ts") as typeof import("./names.ts");
    const resolved = names.resolveName(coordRoot, instanceId, sessionId);
    if (resolved) {
      name = resolved.name;
      kind = resolved.kind;
      // An explicitly assumed session carries its durable persona UUID in
      // name-history. Native subagents continue to use instance_id.
      agentId = resolved.agent_id ?? (resolved.kind === "subagent" ? instanceId : "");
    } else if (!sessionId || sessionId === instanceId) {
      // A main session with NO history at all never fired session.start —
      // the CC fork flow (SessionStart fires under the parent's id before
      // the fork id is minted), or a partially-wired adapter. Mint its pool
      // name here instead of leaving a nameless heartbeat, and stamp the
      // detected fork lineage while we're at it. A sessionId that differs
      // from instanceId is left alone: that shape is a subagent whose parent
      // is also unknown, and guessing "session" would be wrong.
      name = names.assignName(
        coordRoot,
        instanceId,
        "session",
        opts?.forkedFrom ? { forkedFrom: opts.forkedFrom } : undefined,
      );
    }
  } catch {
    /* names module unavailable, fall back to empty */
  }

  const hb: Heartbeat = {
    schema_version: 1,
    instance_id: instanceId,
    session_id: sessionId ?? instanceId,
    name,
    kind,
    agent_id: agentId,
    model: model ?? "",
    started_at: now,
    last_heartbeat: now,
    files_touched: [],
    // Default to claude-code only when the caller can't tell us the adapter
    // (e.g. manual `harn agents heal`). The live tool.pre_use heal threads the
    // detected adapter so a pruned Cursor/Codex heartbeat is recreated with
    // the correct platform instead of being mislabeled claude-code.
    platform: adapterToPlatform(adapter),
  };
  atomicWrite(path, JSON.stringify(hb, null, 2));
  // Write-only telemetry: only the actual-recreate branch reaches here (the
  // already-alive case returned above), so this records exactly the heals that
  // happened. Recorded fork lineage rides the event too, so derived readers
  // rebuilding from the ledger converge with .name-history.
  emitHealthHeal(coordRoot, "health.heartbeat_heal", instanceId, hb, {
    reason: "missing",
    kind: "heartbeat",
    ...(opts?.forkedFrom ? { forked_from: opts.forkedFrom } : {}),
  });
  return hb;
}

/**
 * Register a workflow child in the coordination layer from the ENGINE side.
 *
 * Previously a spawned child was visible only if its adapter fired Harnery's
 * hooks, which made coordination visibility a property of the vendor CLI
 * rather than of the engine. Headless `codex exec` fires no hooks, so codex
 * children never appeared in `harn agents list` and rendered as "no live
 * session" on the run page while actively working — for the entire length of
 * a multi-minute stage.
 *
 * The engine already knows every fact a heartbeat needs at spawn time, so it
 * writes one itself. Hook-firing adapters keep enriching the same file
 * (last_tool, files_touched); non-hook adapters at least become visible and
 * attributable. Pair with `killHeartbeat` when the child ends.
 *
 * Idempotent: re-registering refreshes in place and preserves `started_at`
 * and any claims a hook already recorded.
 */
export function registerWorkflowChild(
  coordRoot: string,
  opts: {
    instanceId: string;
    runId: string;
    agentId: string;
    sessionId?: string;
    adapter?: string;
    label?: string;
    model?: string;
  },
): Heartbeat {
  const now = nowIsoSeconds();
  const prior = readHeartbeat(coordRoot, opts.instanceId);
  const hb: Heartbeat = {
    ...(prior ?? {}),
    schema_version: 1,
    instance_id: opts.instanceId,
    // The reader keys children by session_id and skips any heartbeat missing
    // one, so it must always be set even before the adapter mints a real id.
    session_id: prior?.session_id ?? opts.sessionId ?? opts.instanceId,
    name: opts.label || opts.agentId,
    kind: "workflow-child",
    agent_id: opts.agentId,
    model: opts.model ?? prior?.model ?? "",
    platform: adapterToPlatform(opts.adapter),
    started_at: prior?.started_at ?? now,
    last_heartbeat: now,
    files_touched: prior?.files_touched ?? [],
    task: opts.label ?? "",
    workflow_run_id: opts.runId,
    workflow_agent_id: opts.agentId,
  };
  atomicWrite(heartbeatPath(coordRoot, opts.instanceId), JSON.stringify(hb, null, 2));
  return hb;
}

/**
 * Stamp the heartbeat with the most-recent tool name + target. Written from
 * the post-tool-use hook.
 */
export function stampToolActivity(
  coordRoot: string,
  instanceId: string,
  toolName: string,
  target: string,
): Heartbeat | null {
  return mutate(coordRoot, instanceId, (hb) => ({
    ...hb,
    last_tool: toolName,
    last_tool_target: target,
    last_tool_at: nowIsoSeconds(),
  }));
}
