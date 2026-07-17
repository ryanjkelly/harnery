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

/** Inline harness normalizer (mirrors canonical-emit.normalizeHarness), kept
 * local so the writer's only cross-module dep is the in-process emit(). */
function harnessOf(platform: string | undefined): "claude-code" | "cursor" | "codex" {
  if (platform === "cursor") return "cursor";
  if (platform === "codex") return "codex";
  return "claude-code";
}

/** Inverse of harnessOf: maps the canonical harness ("claude-code"/"cursor"/
 * "codex") to the legacy underscore platform label stored on the heartbeat.
 * Mirrors heartbeat-projector.harnessToPlatform so a healed heartbeat carries
 * the same platform value projection would have written. */
function harnessToPlatform(harness: string | undefined): string {
  if (harness === "cursor") return "cursor";
  if (harness === "codex") return "codex";
  return "claude_code";
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
      harness: harnessOf(hb?.platform),
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
  last_status_at?: string;
  turn_summary?: string | null;
  turn_summary_updated_at?: string | null;
  last_tool?: string;
  last_tool_target?: string;
  last_tool_at?: string;
  current_turn_id?: string;
  parent_instance_id?: string;
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
    return {
      ...hb,
      task: cleared ? undefined : task,
      task_updated_at: nowIsoSeconds(),
    };
  });
}

export function stampStatusCheck(coordRoot: string, instanceId: string): Heartbeat | null {
  return mutate(coordRoot, instanceId, (hb) => ({
    ...hb,
    last_status_at: nowIsoSeconds(),
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
 * files_touched can hold either absolute-under-coordRoot or canonical
 * repo-relative entries (legacy projections stored the raw tool_input path),
 * so both sides are normalized before comparing — an exact-string match
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
  const platform = hb?.platform ?? "claude_code";
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
  harness?: string,
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
    const { resolveName } = require("./names.ts") as typeof import("./names.ts");
    const resolved = resolveName(coordRoot, instanceId, sessionId);
    if (resolved) {
      name = resolved.name;
      kind = resolved.kind;
      // subagent kind: agent_id == instance_id. Else (session/transient): no id stamp.
      if (resolved.kind === "subagent") agentId = instanceId;
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
    // Default to claude_code only when the caller can't tell us the harness
    // (e.g. manual `harn agents heal`). The live tool.pre_use heal threads the
    // detected harness so a pruned Cursor/Codex heartbeat is recreated with
    // the correct platform instead of being mislabeled claude_code.
    platform: harnessToPlatform(harness),
  };
  atomicWrite(path, JSON.stringify(hb, null, 2));
  // Write-only telemetry: only the actual-recreate branch reaches here (the
  // already-alive case returned above), so this records exactly the heals that
  // happened.
  emitHealthHeal(coordRoot, "health.heartbeat_heal", instanceId, hb, {
    reason: "missing",
    kind: "heartbeat",
  });
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
