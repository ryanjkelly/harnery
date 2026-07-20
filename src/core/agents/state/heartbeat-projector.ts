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

export interface V2Heartbeat {
  instance_id: string;
  session_id: string;
  harness: string;
  agent_id?: string;
  name?: string;
  kind?: "session" | "subagent" | "transient";
  model?: string;
  platform?: string;
  subagent_call_id?: string;
  parent_session_id?: string;
  /** Set iff this owner is a `workflow run` child (joins to the run journal). */
  workflow_run_id?: string;
  started_at?: string;
  last_heartbeat: string;
  last_tool?: string;
  last_tool_target?: string;
  last_tool_at?: string;
  task?: string;
  task_updated_at?: string;
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

  // Terminal events for an owner we've never seen must NOT seed a new heartbeat:
  // that resurrects a dead agent as a nameless, started_at-less zombie (the
  // `agent-unknown (20608d ago)` ghost). It happens when a subagent.stop /
  // session.end drains without (or after) its matching start: seed() then
  // apply(stop) writes a bare tombstone the sweep+readers then choke on. If
  // there's no existing heartbeat and the first event we see for an owner is
  // terminal, skip it entirely.
  //
  // `health.heartbeat_swept` is terminal for the same reason, and was the
  // sharper bug: stale-sweep deletes a dead heartbeat then emits this event,
  // which the projector replayed to RE-CREATE the very file the sweep just
  // removed (minus files_touched, since no start event ever ran for it). The
  // reader then flagged it "missing required fields", and the resurrected file,
  // carrying a fresh last_heartbeat = the swept-event ts, survived one
  // freshness window before the next sweep deleted-and-resurrected it again. A
  // self-perpetuating zombie loop (same instance swept 18×). A swept event must
  // never seed a heartbeat.
  const TERMINAL = new Set(["session.end", "subagent.stop", "health.heartbeat_swept"]);

  // Seed from any existing v2 files so a partial replay doesn't reset state.
  for (const ev of events) {
    if (!perOwner[ev.instance_id]) {
      const existing = readExisting(coordRoot, ev.instance_id);
      if (!existing && TERMINAL.has(ev.event_type)) continue;
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
    harness: ev.harness,
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
  hb.last_heartbeat = ev.ts;
  hb.last_event_id = ev.event_id;
  hb.events_applied += 1;
  hb.v2_meta.last_projected = new Date().toISOString();
  if (ev.turn_id) hb.last_turn_id = ev.turn_id;

  const d = ev.data;
  switch (ev.event_type) {
    case "session.start":
      hb.started_at = pickStr(d, "started_at") ?? ev.ts;
      hb.harness = ev.harness;
      {
        const model = pickStr(d, "model");
        if (model) hb.model = model;
        const platform = pickStr(d, "platform") ?? harnessToPlatform(ev.harness);
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
        if (!hb.files_touched) hb.files_touched = [];
      }
      break;

    case "session.end":
      hb.ended_at = pickStr(d, "ended_at") ?? ev.ts;
      hb.clean_exit = pickBool(d, "clean_exit");
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
      hb.platform = harnessToPlatform(ev.harness);
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
      {
        const summary = pickStr(d, "turn_summary");
        if (summary) {
          hb.turn_summary = summary;
          hb.turn_summary_updated_at = ev.ts;
        }
        // Backfill model for harnesses that omit it at session.start (Claude
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

function harnessToPlatform(harness: string): string {
  if (harness === "claude-code") return "claude_code";
  if (harness === "cursor") return "cursor";
  if (harness === "codex") return "codex";
  return harness;
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
    setIfDefined(merged, "model", hb.model);
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
