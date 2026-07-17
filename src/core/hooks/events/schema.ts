/**
 * Canonical event schema v1. Inter-module contract between agent-hooks (writer)
 * and agent-coord (consumer + projector).
 *
 * Schema evolution rules:
 *   - Forward-compatible only within a major version. Consumers ignore unknown
 *     fields. Adding an optional field is a minor bump; removing or retyping a
 *     field is a major bump.
 *   - Mixed-version streams are legal during migrations; consumers branch on
 *     `schema_version`.
 */

export const SCHEMA_VERSION = 1 as const;

export type Harness = "claude-code" | "cursor" | "codex";

export type Source = "agent-hooks" | "agent-coord" | "user" | "system";

/**
 * Common envelope every event carries. Tool events, `user_prompt.submit`, and
 * `turn.stop` MUST carry `turn_id`; CLI/state/council/presence/health/session
 * events MAY carry `turn_id` when agent-coord can bind them to the active turn
 * for that owner.
 */
export interface EventEnvelope<TType extends string, TData> {
  schema_version: typeof SCHEMA_VERSION;
  event_id: string; // ULID, sortable, unique
  event_type: TType;
  ts: string; // ISO-8601 with milliseconds
  instance_id: string; // resolved by agent-hooks
  session_id: string; // harness-level session
  parent_session_id?: string; // present iff event is from a subagent
  turn_id?: string; // present when event is bound to an assistant turn
  parent_turn_id?: string; // present iff this turn is nested under another
  harness: Harness;
  source: Source;
  data: TData;
}

// ── event catalog ───────────────────────────────────────────────────────

// Lifecycle
export type SessionStart = EventEnvelope<
  "session.start",
  {
    started_at: string;
    cwd: string;
    model?: string;
    pid: number;
    /** Present iff this session is a `workflow run` child: the run id whose
     * journal owns it (child env HARNERY_WORKFLOW_RUN_ID). Optional-field
     * addition per the schema evolution rules (minor bump). */
    workflow_run_id?: string;
  }
>;

export type SessionEnd = EventEnvelope<
  "session.end",
  {
    ended_at: string;
    clean_exit: boolean;
  }
>;

export type SubagentStart = EventEnvelope<
  "subagent.start",
  {
    agent_type: string;
    prompt_summary?: string;
  }
>;

export type SubagentStop = EventEnvelope<
  "subagent.stop",
  {
    exit_status: "ok" | "error" | "interrupted";
  }
>;

export type UserPromptSubmit = EventEnvelope<
  "user_prompt.submit",
  {
    prompt_text: string; // clamped
    truncated?: boolean;
  }
>;

export type TurnStop = EventEnvelope<
  "turn.stop",
  {
    tool_call_count: number;
    text_length: number;
    status_box_present: boolean; // adapter sets via transcript scan for `┌─ agent-` prefix
  }
>;

// Session-telemetry (merge path)
export type CommandStart = EventEnvelope<
  "command.start",
  {
    cmd_id: string;
    intent?: string;
    cmd: string;
  }
>;

export type CommandOutput = EventEnvelope<
  "command.output",
  {
    cmd_id: string;
    stream: "stdout" | "stderr";
    line: string;
  }
>;

export type CommandEnd = EventEnvelope<
  "command.end",
  {
    cmd_id: string;
    exit: number;
    duration_ms: number;
    signal?: string;
  }
>;

export type Narration = EventEnvelope<
  "narration",
  {
    message: string;
  }
>;

// Tools
export type ToolPreUse = EventEnvelope<
  "tool.pre_use",
  {
    tool_name: string;
    tool_input: unknown; // clamped to 8000 chars when stringified
    intent?: string;
    truncated?: boolean;
  }
>;

export type ToolPostUse = EventEnvelope<
  "tool.post_use",
  {
    tool_name: string;
    output_summary: string; // first 500 + last 500
    exit_status: "ok" | "error";
    duration_ms: number;
    truncated?: boolean;
  }
>;

export type ToolPostUseFailure = EventEnvelope<
  "tool.post_use_failure",
  {
    tool_name: string;
    error: string;
    duration_ms: number;
  }
>;

export type ToolOutputChunk = EventEnvelope<
  "tool.output_chunk",
  {
    chunk: string;
    chunk_no: number;
    stream: "stdout" | "stderr";
    truncated?: boolean;
  }
>;

/**
 * An image an agent viewed (Read tool) or produced (a Bash command wrote it).
 * Emitted by agent-hooks as a side-effect of a tool event when the tool
 * references an image path on disk; the bytes are content-addressed into
 * `.harnery/images/<hash>.<ext>` (dedup) and this event records the provenance
 * for the web image feed. Grouped by `hash` downstream → one card per distinct
 * image with a touch timeline.
 */
export type ImageCaptured = EventEnvelope<
  "image.captured",
  {
    hash: string; // sha256 of the file bytes, also the blob's basename
    ext: string; // png | jpg | jpeg | gif | webp | bmp | svg
    bytes: number;
    role: "viewed" | "produced";
    source_path: string; // repo-relative when under coordRoot, else absolute
    tool_name: string; // "Read" (viewed) | "Bash" (produced)
    tool_use_id?: string;
    intent?: string; // present for viewed (carried from the tool event)
    command_head?: string; // present for produced (first ~120 chars of the cmd)
  }
>;

// File claims
export type ClaimAcquire = EventEnvelope<
  "claim.acquire",
  {
    path: string;
    mode: "read" | "write";
  }
>;

export type ClaimRelease = EventEnvelope<
  "claim.release",
  {
    path: string;
    reason: "explicit" | "turn_end" | "session_end" | "heal";
  }
>;

export type ClaimConflict = EventEnvelope<
  "claim.conflict",
  {
    path: string;
    peer_instance_id: string;
    reason?: "ordering_violation" | "concurrent_write";
  }
>;

// Coord state
export type StateTaskSet = EventEnvelope<
  "state.task_set",
  {
    task: string;
    cleared: boolean;
  }
>;

export type StateStatusChecked = EventEnvelope<
  "state.status_checked",
  {
    format: "box" | "json" | "table";
    agent_count: number;
    included_self: boolean;
  }
>;

export type StateScratchAppend = EventEnvelope<
  "state.scratch_append",
  {
    category: "note" | "plan" | "decision" | "blocker" | "question" | "done" | "handoff";
    body_summary: string;
  }
>;

export type StatePresenceChange = EventEnvelope<
  "state.presence_change",
  {
    from: "mobile" | "office";
    to: "mobile" | "office";
    source: "hook" | "cli" | "user";
  }
>;

export type StateHeartbeat = EventEnvelope<"state.heartbeat", Record<string, never>>;

// Council
export type CouncilOpen = EventEnvelope<
  "council.open",
  {
    council_id: string;
    topic: string;
    members: string[];
    target_doc?: string;
  }
>;

export type CouncilRoundOpen = EventEnvelope<
  "council.round_open",
  {
    council_id: string;
    round_no: number;
  }
>;

export type CouncilContribution = EventEnvelope<
  "council.contribution",
  {
    council_id: string;
    round_no: number;
    member: string;
    body_summary: string;
  }
>;

export type CouncilRoundClose = EventEnvelope<
  "council.round_close",
  {
    council_id: string;
    round_no: number;
  }
>;

export type CouncilClose = EventEnvelope<
  "council.close",
  {
    council_id: string;
    closed_at: string;
  }
>;

export type CouncilArchive = EventEnvelope<
  "council.archive",
  {
    council_id: string;
  }
>;

// Decisions (rule-engine verdicts emitted by agent-coord)
export type DecisionBlock = EventEnvelope<
  "decision.block",
  {
    rule: string;
    reason: string;
  }
>;

export type DecisionWarn = EventEnvelope<
  "decision.warn",
  {
    rule: string;
    reason: string;
  }
>;

export type DecisionAllow = EventEnvelope<
  "decision.allow",
  {
    rule: string;
  }
>;

// Health
export type HealthHeartbeatHeal = EventEnvelope<
  "health.heartbeat_heal",
  {
    reason: string;
  }
>;

export type HealthPidmapHeal = EventEnvelope<
  "health.pidmap_heal",
  {
    reason: string;
  }
>;

/**
 * A heartbeat file was removed by stale-sweep. Symmetric with
 * `health.heartbeat_heal` so the full lifecycle (created → healed → swept) is
 * auditable from the event stream alone. Sweeps were silent before, which
 * made "why did this agent vanish?" un-answerable without guesswork.
 * `reason`: "stale" (last_heartbeat past the freshness cutoff) | "unparseable"
 * (JSON.parse failed AND mtime was old) | "missing_ts" (no last_heartbeat AND
 * mtime was old). Fresh-mtime files are never swept regardless of content.
 */
export type HealthHeartbeatSwept = EventEnvelope<
  "health.heartbeat_swept",
  {
    reason: "stale" | "unparseable" | "missing_ts";
    age_secs?: number;
  }
>;

/**
 * fail-open verdict failure mode. Emitted by agent-hooks when
 * `agent-coord verdict` fails to spawn / exits non-zero / returns malformed
 * JSON / times out. Adapter falls through to ALLOW; the event preserves the
 * fail-open for audit.
 */
export type HealthVerdictFailure = EventEnvelope<
  "health.verdict_failure",
  {
    failure_kind: "spawn_failed" | "nonzero_exit" | "malformed_json" | "timeout";
    timeout_ms?: number;
    fallback: "allow";
  }
>;

// ── Discriminated union over every event_type ────────────────────────────────

export type Event =
  | SessionStart
  | SessionEnd
  | SubagentStart
  | SubagentStop
  | UserPromptSubmit
  | TurnStop
  | CommandStart
  | CommandOutput
  | CommandEnd
  | Narration
  | ToolPreUse
  | ToolPostUse
  | ToolPostUseFailure
  | ToolOutputChunk
  | ImageCaptured
  | ClaimAcquire
  | ClaimRelease
  | ClaimConflict
  | StateTaskSet
  | StateStatusChecked
  | StateScratchAppend
  | StatePresenceChange
  | StateHeartbeat
  | CouncilOpen
  | CouncilRoundOpen
  | CouncilContribution
  | CouncilRoundClose
  | CouncilClose
  | CouncilArchive
  | DecisionBlock
  | DecisionWarn
  | DecisionAllow
  | HealthHeartbeatHeal
  | HealthPidmapHeal
  | HealthHeartbeatSwept
  | HealthVerdictFailure;

export type EventType = Event["event_type"];

/**
 * Redaction marker that may be attached to any `data` payload during emission.
 * Tracked here so the schema documents the convention; the actual
 * shape lives inside `data` so it doesn't widen the envelope.
 */
export interface RedactionMarker {
  field: string;
  kind: "secret_signature" | "env_secret_match" | "length_clamp";
  count: number;
}
