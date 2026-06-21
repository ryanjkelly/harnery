/**
 * Reader for the command-output stream consumed by the `/live` viewer.
 *
 * As of the Phase-6 session-events retirement this reads the **canonical**
 * `.harnery/events.ndjson` (the single source of truth) and projects the
 * command stream back into the flat `SessionEvent` shape the renderers expect:
 * the `command.*` + `narration` envelopes (emitted by the host CLI), PLUS bare shell
 * commands captured by the agent-hook tap (`tool.pre_use` / `tool.post_use`
 * with `tool_name="Bash"`: git/grep/curl/cat/…). The legacy
 * `.harnery/session-events.ndjson` stream is gone; its command/narration
 * telemetry now lives in events.ndjson alongside the hook events (see
 * harnery/src/core/agents/session-events.ts).
 *
 * The sibling `coord-reader.ts#readEvents` reads the same file for the `/events`
 * view (the complete firehose, every event type); this reader filters to the
 * command stream (shell commands + narration), dropping non-Bash tool calls
 * (Read/Edit/Write/…) and state/session events.
 */

import fs from "node:fs";
import path from "node:path";

import { harneryDir } from "./coord-reader";

export interface SessionEvent {
  ts: string;
  type:
    | "command_start"
    | "output"
    | "command_end"
    | "end_of_turn"
    | "hook_event"
    | "set_task"
    | "file_claim"
    | "file_release"
    | "peer_change"
    | "narration";
  /** Bare display name ("Maya"), resolved from the heartbeat by instance_id. */
  agent_name: string;
  /** Durable persona UUID; optional, not carried on the canonical envelope. */
  agent_id?: string;
  instance_id?: string;
  cmd_id?: string;
  intent?: string;
  cmd?: string;
  line?: string;
  stream?: "stdout" | "stderr";
  exit?: number | null;
  signal?: string | null;
  duration_ms?: number;
  message?: string;
}

/** Canonical `event_type` → legacy `SessionEvent.type`. Only the command
 * stream + narration are projected; every other canonical event (tool.*,
 * state.*, session.*, …) belongs to the `/events` view and is filtered out. */
const CANON_TO_LEGACY: Record<string, SessionEvent["type"]> = {
  "command.start": "command_start",
  "command.output": "output",
  "command.end": "command_end",
  narration: "narration",
};

/** Canonical envelope as written by harnery's in-process emit(). */
interface CanonicalEnvelope {
  event_type?: string;
  ts?: string;
  instance_id?: string;
  session_id?: string;
  data?: Record<string, unknown>;
}

/** instance_id → display name, refreshed from active/ heartbeats on a short
 * TTL so a chatty tail doesn't re-scan the directory per line. */
let nameCache: { at: number; map: Map<string, string> } | null = null;
const NAME_TTL_MS = 5000;

function resolveAgentName(instanceId: string | undefined): string {
  if (!instanceId) return "";
  const now = Date.now();
  if (!nameCache || now - nameCache.at > NAME_TTL_MS) {
    const map = new Map<string, string>();
    try {
      const activeDir = path.join(harneryDir(), "active");
      for (const f of fs.readdirSync(activeDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const hb = JSON.parse(fs.readFileSync(path.join(activeDir, f), "utf8")) as {
            instance_id?: string;
            name?: string;
          };
          if (hb.instance_id && hb.name) map.set(hb.instance_id, hb.name);
        } catch {
          /* skip unreadable heartbeat */
        }
      }
    } catch {
      /* no active dir, leave map empty */
    }
    nameCache = { at: now, map };
  }
  return nameCache.map.get(instanceId) ?? "";
}

/**
 * Project one raw ndjson object into a `SessionEvent`, or `null` when the line
 * isn't part of the command stream. Handles both the canonical envelope
 * (`event_type` + nested `data`) and, defensively, any residual flat legacy
 * line (`type` at top level) so a mid-migration file never breaks the viewer.
 */
function project(raw: Record<string, unknown>): SessionEvent | null {
  // Canonical envelope.
  if (typeof raw.event_type === "string") {
    const env = raw as CanonicalEnvelope;
    const etype = env.event_type as string;
    const data = (env.data ?? {}) as Record<string, unknown>;
    const legacyType = CANON_TO_LEGACY[etype];
    if (legacyType) {
      return {
        ts: (env.ts as string) ?? "",
        type: legacyType,
        instance_id: env.instance_id,
        agent_name: resolveAgentName(env.instance_id),
        cmd_id: data.cmd_id as string | undefined,
        intent: data.intent as string | undefined,
        cmd: data.cmd as string | undefined,
        line: data.line as string | undefined,
        stream: data.stream as "stdout" | "stderr" | undefined,
        exit: data.exit as number | null | undefined,
        signal: data.signal as string | null | undefined,
        duration_ms: data.duration_ms as number | undefined,
        message: data.message as string | undefined,
      };
    }
    // Bare shell commands captured by the agent-hook tap (git/grep/curl/cat/…)
    // arrive as tool.pre_use / tool.post_use with tool_name="Bash". They carry
    // the same command + intent the command.* stream does, and there are ~14×
    // more of them than the host CLI command.* events, so the /live command view
    // projects them too. A command that *starts* with the host CLI never appears here
    // (the middleware emits its command.* and the tap skips it), so no
    // double-render in the common case. The one residual overlap is a compound
    // Bash call that wraps a harn invocation (e.g. `cd x && harn y`): the tap emits
    // a tool.pre_use for the whole wrapper AND the middleware emits command.* for
    // the inner bp, so both rows show. Accepted: the wrapper row still carries
    // useful intent + context, and stateless de-dup here would risk hiding real
    // bare commands (a literal "harn " can appear inside a grep/echo). Failures
    // route to tool.post_use_failure. Non-Bash tools (Read/Edit/Write/
    // AskUserQuestion/…) and state.*/session.* stay on /events.
    if (data.tool_name === "Bash") {
      // Subagent (Agent-tool dispatch) events carry the parent's session_id +
      // the subagent's own instance_id, so the two differ; a main-agent event
      // has them equal. Subagent shell commands are almost all un-narrated
      // find/grep exploration (empirically ~205/211 carry no intent, vs ~0 for
      // main agents), so the /live command view drops the un-narrated ones as
      // noise, keeping subagent commands that DO carry a `# intent:`.
      const isSubagent =
        !!env.session_id &&
        !!env.instance_id &&
        env.session_id !== env.instance_id;
      const intentRaw = typeof data.intent === "string" ? data.intent : "";
      const intent =
        intentRaw && intentRaw !== "(no intent)" ? intentRaw : undefined;
      if (etype === "tool.pre_use") {
        if (isSubagent && !intent) return null; // drop un-narrated subagent spam
        const cmd = bashCommandText(data);
        if (!cmd) return null;
        return {
          ts: (env.ts as string) ?? "",
          type: "command_start",
          instance_id: env.instance_id,
          agent_name: resolveAgentName(env.instance_id),
          cmd,
          intent,
          cmd_id: typeof data.tool_use_id === "string" ? data.tool_use_id : undefined,
        };
      }
      if (etype === "tool.post_use" || etype === "tool.post_use_failure") {
        // Subagent exit rows pair with a possibly-dropped no-intent start and
        // can't be correlated statelessly, so drop them all (low value) so no
        // orphan "exit ✓" rows appear under a subagent.
        if (isSubagent) return null;
        const dur = Number(data.duration_ms);
        return {
          ts: (env.ts as string) ?? "",
          type: "command_end",
          instance_id: env.instance_id,
          agent_name: resolveAgentName(env.instance_id),
          cmd_id: typeof data.tool_use_id === "string" ? data.tool_use_id : undefined,
          // tap doesn't surface the numeric code; failure→1, success→0.
          exit: etype === "tool.post_use_failure" ? 1 : 0,
          // duration_ms is unpopulated on the tap (always 0), so omit it so the
          // renderer doesn't print a misleading "0ms".
          duration_ms: Number.isFinite(dur) && dur > 0 ? dur : undefined,
        };
      }
    }
    return null; // other canonical events belong to /events, not the command view
  }
  // Defensive back-compat: a flat legacy command-stream line still in the file.
  if (typeof raw.type === "string") {
    const t = raw.type as string;
    if (t === "command_start" || t === "output" || t === "command_end" || t === "narration") {
      const agent_name =
        (raw.agent_name as string | undefined) ?? (raw.agent as string | undefined) ?? "";
      return { ...(raw as object), agent_name } as SessionEvent;
    }
  }
  return null;
}

/** Pull a one-line, intent-comment-stripped command string out of a Bash tool
 * event's `tool_input` (which arrives as either an object or a JSON-encoded
 * string, depending on the producer). The leading `# intent: …` comment is
 * dropped because the intent renders separately; multi-line scripts collapse to
 * a single line and truncate at 240 chars (the full text stays in the raw row).
 * Returns "" when there's nothing usable. */
function bashCommandText(data: Record<string, unknown>): string {
  const ti = data.tool_input;
  let command = "";
  if (ti && typeof ti === "object") {
    command = String((ti as Record<string, unknown>).command ?? "");
  } else if (typeof ti === "string") {
    try {
      const parsed = JSON.parse(ti) as { command?: unknown };
      command = typeof parsed?.command === "string" ? parsed.command : ti;
    } catch {
      command = ti;
    }
  }
  if (!command) return "";
  const collapsed = command
    .split("\n")
    .filter((l) => !/^\s*#\s*intent:/i.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 240)}…` : collapsed;
}

/** Path to the canonical stream the command viewer now reads. */
export function sessionEventsPath(): string {
  return path.join(harneryDir(), "events.ndjson");
}

/** Bytes read from the tail for the large-file path. Sized to comfortably
 * contain the default snapshot (`lines`, now 1000) of command rows even though
 * they're interleaved with the tool/state events the projection drops. */
const TAIL_READ_BYTES = 8_000_000;

/**
 * Read the tail of the canonical stream, projected to the command-stream
 * `SessionEvent` shape. Lines that fail to parse or aren't command events are
 * skipped. Returns at most `lines` events (most recent).
 */
export async function readSessionEventsTail(opts: {
  lines?: number;
  agent?: string;
} = {}): Promise<SessionEvent[]> {
  const { lines = 200, agent } = opts;
  const filePath = sessionEventsPath();
  try {
    const stat = await fs.promises.stat(filePath);
    let text: string;
    if (stat.size > TAIL_READ_BYTES) {
      const startOffset = stat.size - TAIL_READ_BYTES;
      const fh = await fs.promises.open(filePath, "r");
      try {
        const buf = Buffer.alloc(TAIL_READ_BYTES);
        await fh.read(buf, 0, TAIL_READ_BYTES, startOffset);
        text = buf.toString("utf8");
      } finally {
        await fh.close();
      }
      // Drop the first (likely partial) line.
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    } else {
      text = await fs.promises.readFile(filePath, "utf8");
    }

    const out: SessionEvent[] = [];
    for (const raw of text.split("\n")) {
      if (!raw) continue;
      try {
        const ev = project(JSON.parse(raw) as Record<string, unknown>);
        if (!ev) continue;
        if (agent && ev.agent_name !== agent) continue;
        out.push(ev);
      } catch {
        // skip malformed lines
      }
    }
    if (out.length > lines) return out.slice(-lines);
    return out;
  } catch {
    return [];
  }
}

/**
 * Stream new command events appended after a byte offset. Caller tracks
 * position; we stop when no new content is available (call again after
 * fs.watch fires). Incremental, so the command-event density of events.ndjson
 * is a non-issue here; we return whatever command rows the new bytes held.
 */
export async function readEventsAfter(
  offset: number,
  agent?: string,
): Promise<{ events: SessionEvent[]; newOffset: number }> {
  const filePath = sessionEventsPath();
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size <= offset) {
      return { events: [], newOffset: offset };
    }
    const fh = await fs.promises.open(filePath, "r");
    try {
      const length = stat.size - offset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);
      const text = buf.toString("utf8");
      const lastNl = text.lastIndexOf("\n");
      const consumed = lastNl >= 0 ? lastNl + 1 : 0;
      const payload = text.slice(0, consumed);
      const events: SessionEvent[] = [];
      for (const raw of payload.split("\n")) {
        if (!raw) continue;
        try {
          const ev = project(JSON.parse(raw) as Record<string, unknown>);
          if (!ev) continue;
          if (agent && ev.agent_name !== agent) continue;
          events.push(ev);
        } catch {
          // skip
        }
      }
      return { events, newOffset: offset + consumed };
    } finally {
      await fh.close();
    }
  } catch {
    return { events: [], newOffset: offset };
  }
}

/** Initial offset for tail-stream connect: end of current file. */
export async function currentEventsFileSize(): Promise<number> {
  try {
    const stat = await fs.promises.stat(sessionEventsPath());
    return stat.size;
  } catch {
    return 0;
  }
}
