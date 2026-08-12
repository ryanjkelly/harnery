/**
 * Heartbeat projector. Reads canonical events from the consumer and projects
 * them into per-owner state files under `.harnery/active/<id>.json`, the same
 * canonical location every reader (this library, hooks, the web UI, etc.)
 * expects.
 *
 * Projection writes a single file, additively merged with any existing body
 * so writes from sibling tools (e.g. `agent-coord set-task` that doesn't go
 * through the canonical event stream) survive each projector run.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CanonicalEvent } from "../events/consume.ts";
import { type AgentActivity, applySessionStateEvent, type TaskState } from "./session-state.ts";

export interface V2Heartbeat {
  instance_id: string;
  session_id: string;
  adapter: string;
  agent_id?: string;
  name?: string;
  kind?: "session" | "subagent" | "transient";
  model?: string;
  instruction_bundle_id?: string;
  instruction_source_id?: string;
  instruction_profile_root?: string;
  instruction_component_count?: number;
  platform?: string;
  subagent_call_id?: string;
  parent_session_id?: string;
  /** Set iff this owner is a `workflow run` child (joins to the run transcript). */
  workflow_run_id?: string;
  workflow_agent_id?: string;
  started_at?: string;
  last_heartbeat: string;
  last_tool?: string;
  last_tool_target?: string;
  last_tool_at?: string;
  task?: string;
  task_updated_at?: string;
  activity?: AgentActivity;
  activity_updated_at?: string;
  activity_source?: string;
  task_state?: TaskState;
  task_state_updated_at?: string;
  task_state_reason?: string;
  suggested_session_name?: string;
  session_name_seen_at?: string;
  session_name_seen_for?: string;
  last_status_at?: string;
  presence?: "mobile" | "office";
  last_intent?: string;
  last_intent_source?: string;
  last_turn_id?: string;
  last_user_prompt_at?: string;
  last_turn_stop_at?: string;
  last_turn_status_box_present?: boolean;
  ended_at?: string;
  clean_exit?: boolean;
  files_touched?: string[];
  turn_summary?: string;
  turn_summary_updated_at?: string;
  /** ULID of the last event applied for this owner; idempotency anchor. */
  last_event_id: string;
  /** Count of events applied for this owner since the projector first saw it. */
  events_applied: number;
  /** Internal projection metadata. */
  v2_meta: {
    schema_version: 1;
    first_seen: string;
    last_projected: string;
  };
}

export function projectHeartbeats(
  coordRoot: string,
  events: readonly CanonicalEvent[],
): { written: string[]; perOwner: Record<string, V2Heartbeat> } {
  const perOwner: Record<string, V2Heartbeat> = {};

  // Events that must NOT seed a heartbeat for an owner with no live file.
  // Terminal lifecycle events (session.end / subagent.stop /
  // health.heartbeat_swept) used to be the whole set — a stop without a
  // matching start resurrected a nameless `agent-unknown` tombstone, and a
  // lone health.heartbeat_swept re-created the file stale-sweep had just
  // deleted (self-perpetuating zombie loop, same instance swept 18×).
  //
  // `claim.release` joins them: kill-heartbeat unlinks the file THEN emits
  // claim.release for each held path so replay honors the drop. Projecting
  // those releases alone used to seed a fresh heartbeat (name recovered from
  // .name-history, last_heartbeat = release ts), undoing the kill. Side-effect
  // events must never birth an owner.
  const NEVER_SEED = new Set([
    "session.end",
    "subagent.stop",
    "health.heartbeat_swept",
    "claim.release",
  ]);

  // Seed from any existing v2 files so a partial replay doesn't reset state.
  for (const ev of events) {
    if (!perOwner[ev.instance_id]) {
      const existing = readExisting(coordRoot, ev.instance_id);
      if (!existing && NEVER_SEED.has(ev.event_type)) continue;
      perOwner[ev.instance_id] = existing ?? seed(ev, coordRoot);
    }
    apply(perOwner[ev.instance_id]!, ev, coordRoot);
  }

  const written: string[] = [];
  for (const [instance_id, hb] of Object.entries(perOwner)) {
    // Mid-batch terminal guard: the replay variant of the seed-time TERMINAL
    // skip above. A drain that replays a COMPLETED run end-to-end (shared
    // cursor lagging another consumer, replayAll) seeds from the start event,
    // applies the whole history INCLUDING the terminal stop, then lands here
    // and would re-create the heartbeat the end-hook already unlinked, a
    // zombie that reads as a live agent for a full staleness window (observed:
    // a finished subagent's heartbeat resurrected 4m after its stop by a
    // sibling's spawn drain). `ended_at` is only ever set by apply() in this
    // batch, it is not in writeHeartbeat's persisted allowlist, so it can't
    // arrive from disk. If the batch saw the owner end and no heartbeat file
    // exists now, there is nothing live to update: skip. An EXISTING file
    // still gets the terminal write (tombstone semantics, locked by the
    // "session.end on an EXISTING heartbeat still applies" test).
    if (hb.ended_at && !existsSync(heartbeatPath(coordRoot, instance_id))) continue;
    writeHeartbeat(coordRoot, instance_id, hb);
    written.push(instance_id);
  }
  return { written, perOwner };
}

function seed(ev: CanonicalEvent, coordRoot: string): V2Heartbeat {
  const nowIso = new Date().toISOString();
  const hb: V2Heartbeat = {
    instance_id: ev.instance_id,
    session_id: ev.session_id,
    adapter: ev.adapter,
    last_heartbeat: ev.ts,
    last_event_id: ev.event_id,
    events_applied: 0,
    v2_meta: {
      schema_version: 1,
      first_seen: nowIso,
      last_projected: nowIso,
    },
  };

  // Recover identity from the durable `.name-history`. That file is written
  // in-process at session.start / subagent.start time, BEFORE any projection,
  // keyed by instance_id, surviving sweeps. Without this, seeding from a
  // non-start event (a tool/turn whose start was never in a projected batch,
  // e.g. the owner id resolved differently at start than later) produced a
  // nameless `agent-unknown` heartbeat. Mirrors heartbeat-writer.healHeartbeat
  // so BOTH heartbeat producers resolve identity the same way. Best-effort: a
  // names.ts failure must never break projection (a past
  // stop-projection crash that stalled the whole drain).
  try {
    const { resolveName } = require("./names.ts") as typeof import("./names.ts");
    const resolved = resolveName(coordRoot, ev.instance_id, ev.session_id);
    if (resolved) {
      hb.name = resolved.name;
      hb.kind = resolved.kind;
      hb.agent_id =
        resolved.agent_id ?? (resolved.kind === "subagent" ? ev.instance_id : undefined);
    }
  } catch {
    /* name-history unavailable: seed stays nameless; sweep + render guards cope */
  }

  return hb;
}

function apply(hb: V2Heartbeat, ev: CanonicalEvent, coordRoot: string): void {
  // Sweep telemetry must not refresh liveness. apply() used to stamp
  // last_heartbeat = ev.ts for every event, so a drain that replayed
  // [session.start … tools … health.heartbeat_swept] wrote a heartbeat whose
  // last_heartbeat was the swept ts — looking freshly alive for another
  // freshness window, which the next sweep deleted-and-re-emitted. Record the
  // event for audit (last_event_id / events_applied) but keep the prior
  // liveness stamp; also set ended_at so the mid-batch write guard skips
  // re-creating a file the sweep/kill already removed.
  const isSweepTelemetry = ev.event_type === "health.heartbeat_swept";
  if (!isSweepTelemetry) {
    hb.last_heartbeat = ev.ts;
  } else if (!hb.last_heartbeat) {
    hb.last_heartbeat = ev.ts;
  }
  hb.last_event_id = ev.event_id;
  hb.events_applied += 1;
  hb.v2_meta.last_projected = new Date().toISOString();
  if (ev.turn_id) hb.last_turn_id = ev.turn_id;

  const sessionState = applySessionStateEvent(hb, ev);
  hb.activity = sessionState.activity;
  hb.activity_updated_at = sessionState.activity_updated_at;
  hb.activity_source = sessionState.activity_source;
  hb.task_state = sessionState.task_state;
  hb.task_state_updated_at = sessionState.task_state_updated_at;
  hb.task_state_reason = sessionState.task_state_reason;

  const d = ev.data;
  switch (ev.event_type) {
    case "session.start":
      hb.started_at = pickStr(d, "started_at") ?? ev.ts;
      hb.adapter = ev.adapter;
      {
        const model = pickStr(d, "model");
        if (model) hb.model = model;
        const instructionBundleId = pickStr(d, "instruction_bundle_id");
        if (instructionBundleId) hb.instruction_bundle_id = instructionBundleId;
        const instructionSourceId = pickStr(d, "instruction_source_id");
        if (instructionSourceId) hb.instruction_source_id = instructionSourceId;
        const instructionProfileRoot = pickStr(d, "instruction_profile_root");
        if (instructionProfileRoot) hb.instruction_profile_root = instructionProfileRoot;
        const instructionComponentCount = pickNum(d, "instruction_component_count");
        if (instructionComponentCount !== undefined) {
          hb.instruction_component_count = instructionComponentCount;
        }
        const platform = pickStr(d, "platform") ?? adapterToPlatform(ev.adapter);
        hb.platform = platform;
        const name = pickStr(d, "name");
        if (name) hb.name = name;
        const kind = pickStr(d, "kind");
        if (kind === "session" || kind === "subagent" || kind === "transient") {
          hb.kind = kind;
        } else if (!hb.kind) {
          hb.kind = "session";
        }
        const agentId = pickStr(d, "agent_id");
        if (agentId) hb.agent_id = agentId;
        const subagentCallId = pickStr(d, "subagent_call_id");
        if (subagentCallId) hb.subagent_call_id = subagentCallId;
        const parentSession = pickStr(d, "parent_session_id");
        if (parentSession) hb.parent_session_id = parentSession;
        const workflowRunId = pickStr(d, "workflow_run_id");
        if (workflowRunId) hb.workflow_run_id = workflowRunId;
        const workflowAgentId = pickStr(d, "workflow_agent_id");
        if (workflowAgentId) hb.workflow_agent_id = workflowAgentId;
        if (!hb.files_touched) hb.files_touched = [];
      }
      break;

    case "session.end":
      hb.ended_at = pickStr(d, "ended_at") ?? ev.ts;
      hb.clean_exit = pickBool(d, "clean_exit");
      break;

    case "health.heartbeat_swept":
      hb.ended_at = ev.ts;
      break;

    case "subagent.start": {
      const name = pickStr(d, "name");
      if (name) hb.name = name;
      hb.kind = "subagent";
      const parentSession = pickStr(d, "parent_session_id");
      if (parentSession) hb.parent_session_id = parentSession;
      const subagentCallId = pickStr(d, "subagent_call_id");
      if (subagentCallId) hb.subagent_call_id = subagentCallId;
      hb.agent_id = ev.instance_id;
      hb.started_at = ev.ts;
      if (!hb.files_touched) hb.files_touched = [];
      hb.platform = adapterToPlatform(ev.adapter);
      break;
    }

    case "subagent.stop":
      hb.ended_at = pickStr(d, "ended_at") ?? ev.ts;
      hb.clean_exit = pickBool(d, "clean_exit") ?? true;
      break;

    case "user_prompt.submit":
      hb.last_user_prompt_at = ev.ts;
      break;

    case "turn.stop":
      hb.last_turn_stop_at = ev.ts;
      hb.last_turn_status_box_present = pickBool(d, "status_box_present");
      // Rebuild fidelity for the naming ritual: the live stamp is written by
      // the Stop hook (stampSessionNameSeen); reproduce it from the event so a
      // full projector rebuild doesn't re-open a satisfied naming window.
      if (d.session_name_present === true) {
        hb.session_name_seen_at ??= ev.ts;
        // Attribute the sighting to the name the scan actually covered. Reading
        // the name current at this point in the replay instead re-attributed an
        // old sighting to a re-minted name, which faked "already seen" for a
        // name no reply had shown. An event without the field predates it, so
        // leave the attribution unset and let the next stop re-scan.
        hb.session_name_seen_for = pickStr(d, "session_name_present_for");
      }
      {
        const summary = pickStr(d, "turn_summary");
        if (summary) {
          hb.turn_summary = summary;
          hb.turn_summary_updated_at = ev.ts;
        }
        // Backfill model for adapters that omit it at session.start (Claude
        // Code). The Stop hook resolves it from the transcript by this point;
        // only set when present so we never clobber a known model.
        const model = pickStr(d, "model");
        if (model) hb.model = model;
      }
      break;

    case "tool.pre_use": {
      const toolName = pickStr(d, "tool_name");
      hb.last_tool = toolName;
      hb.last_tool_target = extractTarget(d);
      hb.last_tool_at = ev.ts;
      const intent = pickStr(d, "intent");
      if (intent && intent !== "(no intent)") {
        hb.last_intent = intent;
        hb.last_intent_source = pickStr(d, "intent_source");
      }
      // Project files_touched: Edit / Write / NotebookEdit add their target.
      if (toolName === "Edit" || toolName === "Write" || toolName === "NotebookEdit") {
        const target = extractFilePath(d);
        if (target) {
          // Canonicalize to repo-relative before storing: the claim guard
          // writes canonical paths directly, so an absolute entry here would
          // double-count the same file (inflated "N files" display) and
          // defeat exact-match pruning on commit.
          const canonical = target.startsWith(`${coordRoot}/`)
            ? target.slice(coordRoot.length + 1)
            : target;
          if (!hb.files_touched) hb.files_touched = [];
          if (!hb.files_touched.includes(canonical)) hb.files_touched.push(canonical);
        }
      }
      break;
    }

    case "tool.post_use":
    case "tool.post_use_failure":
      hb.last_tool_at = ev.ts;
      break;

    case "state.task_set": {
      const cleared = pickBool(d, "cleared");
      const task = pickStr(d, "task");
      if (cleared || !task) {
        hb.task = undefined;
      } else {
        hb.task = task;
      }
      hb.task_updated_at = ev.ts;
      // Rebuild fidelity: the naming call carries the name it produced.
      const suggested = pickStr(d, "suggested_session_name");
      if (suggested && !hb.suggested_session_name) {
        hb.suggested_session_name = suggested;
      }
      break;
    }

    case "state.status_checked":
      hb.last_status_at = ev.ts;
      break;

    case "identity.assumed": {
      const name = pickStr(d, "name");
      const agentId = pickStr(d, "agent_id");
      if (name) hb.name = name;
      if (agentId) hb.agent_id = agentId;
      break;
    }

    case "state.presence_change": {
      const to = pickStr(d, "to");
      if (to === "mobile" || to === "office") hb.presence = to;
      break;
    }

    case "claim.acquire": {
      const path = pickStr(d, "path");
      const mode = pickStr(d, "mode");
      if (path && mode === "write") {
        const canonical = path.startsWith(`${coordRoot}/`)
          ? path.slice(coordRoot.length + 1)
          : path;
        if (!hb.files_touched) hb.files_touched = [];
        if (!hb.files_touched.includes(canonical)) hb.files_touched.push(canonical);
      }
      break;
    }

    case "claim.release": {
      const path = pickStr(d, "path");
      if (path && hb.files_touched) {
        // files_touched holds a mix of absolute-under-coordRoot and canonical
        // repo-relative entries (Edit events report absolute; release-claim
        // canonicalizes to relative). Normalize both sides so a release
        // subtracts regardless of form — an exact-string compare silently
        // no-ops on the mismatch and the claim resurrects on the next replay.
        const norm = (p: string): string =>
          p.startsWith(`${coordRoot}/`) ? p.slice(coordRoot.length + 1) : p;
        const target = norm(path);
        hb.files_touched = hb.files_touched.filter((p) => norm(p) !== target);
      }
      break;
    }
  }
}

function adapterToPlatform(adapter: string): string {
  if (adapter === "claude-code") return "claude-code";
  if (adapter === "cursor") return "cursor";
  if (adapter === "codex") return "codex";
  return adapter;
}

function extractFilePath(data: Record<string, unknown>): string | undefined {
  const raw = data.tool_input;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (
      pickStr(parsed, "file_path") ??
      pickStr(parsed, "path") ??
      pickStr(parsed, "notebook_path") ??
      undefined
    );
  } catch {
    return undefined;
  }
}

function extractTarget(data: Record<string, unknown>): string | undefined {
  // tool_input is stringified JSON in our envelope; try to parse and pull a
  // common target field (file_path, path, command).
  const raw = data.tool_input;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (
      pickStr(parsed, "file_path") ??
      pickStr(parsed, "path") ??
      pickStr(parsed, "notebook_path") ??
      cleanCommand(pickStr(parsed, "command")) ??
      undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * The repo mandates a `# intent: …` first-line comment on every Bash command,
 * so a raw `command` payload starts with the intent prose, not the command.
 * Stamping that into `last_tool_target` leaked the intent into the peer table
 * and pushed the real command past the 60-char render slice. Skip leading
 * comment-only lines so the target reflects what the agent is actually running.
 */
function cleanCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  for (const line of command.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    return trimmed;
  }
  // All-comment / degenerate: fall back to the trimmed whole.
  return command.trim() || undefined;
}

function readExisting(coordRoot: string, instanceId: string): V2Heartbeat | null {
  const path = heartbeatPath(coordRoot, instanceId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<V2Heartbeat>;
    return coerceV2Heartbeat(raw, instanceId);
  } catch {
    return null;
  }
}

/**
 * Restore the projector-owned invariant fields on a heartbeat read from disk.
 *
 * The active-heartbeat file has multiple producers: the projector (seed/apply,
 * which set `v2_meta` + `events_applied`) AND the writer layer
 * (heartbeat-writer.ts: healHeartbeat, setTask, stampToolActivity, …), which
 * only knows the v1 shape and omits both. readExisting previously `as`-cast the
 * raw JSON straight to V2Heartbeat, so a body recreated by `healHeartbeat`
 * (e.g. a pruned Cursor session) reached apply() without `v2_meta` →
 * `hb.v2_meta.last_projected = …` threw (caught + logged ~200×/day, phase
 * "stop-projection"), and without `events_applied` → `events_applied += 1`
 * silently went NaN. The read boundary is where untyped JSON becomes a typed
 * V2Heartbeat, so it's where the type's required-field invariant must be
 * re-established, covering every malformed producer, not just one symptom.
 *
 * Note `v2_meta` is NOT in writeHeartbeat's persisted allowlist, so it never
 * lands on disk; it's ephemeral per-drain bookkeeping, which means readExisting
 * must re-coerce it on EVERY read of an already-seen owner (not only for
 * heal-written bodies). `events_applied` IS persisted, so coercing it to 0 only
 * matters for bodies a writer produced without the field (e.g. healHeartbeat).
 */
function coerceV2Heartbeat(raw: Partial<V2Heartbeat>, instanceId: string): V2Heartbeat {
  const hb = raw as V2Heartbeat;
  if (!hb.instance_id) hb.instance_id = instanceId;
  if (typeof hb.events_applied !== "number" || Number.isNaN(hb.events_applied)) {
    hb.events_applied = 0;
  }
  if (!hb.v2_meta) {
    const nowIso = new Date().toISOString();
    hb.v2_meta = {
      schema_version: 1,
      first_seen: hb.last_heartbeat ?? nowIso,
      last_projected: nowIso,
    };
  }
  return hb;
}

function writeHeartbeat(coordRoot: string, instanceId: string, hb: V2Heartbeat): void {
  const path = heartbeatPath(coordRoot, instanceId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Additive merge with existing body so writes from sibling tools (e.g.
    // `agent-coord set-task` that doesn't go through the canonical event
    // stream) survive each projector run. Projected fields win on conflict.
    let existing: Record<string, unknown> = {};
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        /* skip merge */
      }
    }
    const merged: Record<string, unknown> = {
      schema_version: 1,
      ...existing,
      instance_id: hb.instance_id,
      session_id: hb.session_id,
      last_heartbeat: hb.last_heartbeat,
      last_event_id: hb.last_event_id,
      events_applied: hb.events_applied,
    };
    setIfDefined(merged, "name", hb.name);
    setIfDefined(merged, "kind", hb.kind);
    setIfDefined(merged, "agent_id", hb.agent_id);
    setIfDefined(merged, "subagent_call_id", hb.subagent_call_id);
    setIfDefined(merged, "workflow_run_id", hb.workflow_run_id);
    setIfDefined(merged, "workflow_agent_id", hb.workflow_agent_id);
    setIfDefined(merged, "model", hb.model);
    setIfDefined(merged, "instruction_bundle_id", hb.instruction_bundle_id);
    setIfDefined(merged, "instruction_source_id", hb.instruction_source_id);
    setIfDefined(merged, "instruction_profile_root", hb.instruction_profile_root);
    setIfDefined(merged, "instruction_component_count", hb.instruction_component_count);
    setIfDefined(merged, "platform", hb.platform);
    setIfDefined(merged, "started_at", hb.started_at);
    // files_touched is a required-array invariant for every reader
    // (coord-reader.isHeartbeatShape, the web UI, stale-sweep). Seed paths that
    // never hit a start event leave it undefined; default to [] so the writer
    // can never emit a file that fails the reader's shape check. Belt to the
    // TERMINAL guard's suspenders.
    merged.files_touched = hb.files_touched ?? [];
    setIfDefined(merged, "last_tool", hb.last_tool);
    setIfDefined(merged, "last_tool_target", hb.last_tool_target);
    setIfDefined(merged, "last_tool_at", hb.last_tool_at);
    setIfDefined(merged, "task", hb.task);
    setIfDefined(merged, "task_updated_at", hb.task_updated_at);
    setIfDefined(merged, "activity", hb.activity);
    setIfDefined(merged, "activity_updated_at", hb.activity_updated_at);
    setIfDefined(merged, "activity_source", hb.activity_source);
    setIfDefined(merged, "task_state", hb.task_state);
    setIfDefined(merged, "task_state_updated_at", hb.task_state_updated_at);
    if (hb.task_state_reason) {
      merged.task_state_reason = hb.task_state_reason;
    } else if (hb.task_state) {
      delete merged.task_state_reason;
    }
    setIfDefined(merged, "suggested_session_name", hb.suggested_session_name);
    setIfDefined(merged, "session_name_seen_at", hb.session_name_seen_at);
    if (hb.session_name_seen_for) {
      merged.session_name_seen_for = hb.session_name_seen_for;
    } else {
      // Unlike most projected fields, an absent attribution is meaningful: a
      // legacy sighting cannot prove which suggested name it covered. Remove a
      // stale value inherited through the additive merge so the next stop
      // scans the current name instead of treating it as already satisfied.
      delete merged.session_name_seen_for;
    }
    setIfDefined(merged, "last_status_at", hb.last_status_at);
    setIfDefined(merged, "turn_summary", hb.turn_summary);
    setIfDefined(merged, "turn_summary_updated_at", hb.turn_summary_updated_at);
    setIfDefined(merged, "current_turn_id", hb.last_turn_id);
    setIfDefined(merged, "parent_instance_id", hb.parent_session_id);
    // Atomic temp+rename (same primitive as heartbeat-writer.ts:atomicWrite) so
    // a concurrent reader (stale-sweep, `harn agents`, the web UI) never sees a
    // half-written file. A plain in-place writeFileSync truncates-then-writes,
    // exposing a partial-read window; stale-sweep deletes any heartbeat it
    // fails to JSON.parse, so a partial read there would delete a live agent.
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    /* surfaced by caller via missing heartbeat file */
  }
}

export function heartbeatPath(coordRoot: string, instanceId: string): string {
  return join(coordRoot, ".harnery", "active", `${instanceId}.json`);
}

/** Set a field only when value is defined (not null/undefined). Used by the
 * additive merge so non-projected writes survive projector runs. */
function setIfDefined<T>(
  target: Record<string, unknown>,
  key: string,
  value: T | undefined | null,
): void {
  if (value !== undefined && value !== null) {
    target[key] = value;
  }
}

function pickStr(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickBool(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  return typeof v === "boolean" ? v : undefined;
}

function pickNum(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
