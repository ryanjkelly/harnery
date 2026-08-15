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

/** The adapters harnery ships first-party hook wiring for. The registry's open
 * `AdapterId` covers any adapter a host registers; this is the closed set, and
 * it is declared exactly once. Re-exported by the two event modules that used
 * to keep their own byte-identical copy. */
export type Adapter = "claude-code" | "cursor" | "codex";

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
  session_id: string; // adapter-level session
  parent_session_id?: string; // present iff event is from a subagent
  turn_id?: string; // present when event is bound to an assistant turn
  parent_turn_id?: string; // present iff this turn is nested under another
  adapter: Adapter;
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
    /** Content hash of every repo-authored instruction/config file this
     * adapter can load for the session's working-path profile. */
    instruction_bundle_id?: string;
    /** Parallel hash of canonical AGENTS.md + .agents sources. This diagnoses
     * sync drift without splitting behavior cohorts when rendered bytes match. */
    instruction_source_id?: string;
    instruction_profile_root?: string;
    instruction_component_count?: number;
    /** Present iff this session is a `workflow run` child: the run id whose
     * transcript owns it (child env HARNERY_WORKFLOW_RUN_ID). Optional-field
     * addition per the schema evolution rules (minor bump). */
    workflow_run_id?: string;
    /** Which agent row of that run this session is running (`a1`, `a2`, …), from
     * child env HARNERY_WORKFLOW_AGENT_ID. Lets a dashboard attribute in-flight
     * child activity to one agent instead of only to the run. */
    workflow_agent_id?: string;
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

/** Direct adapter evidence that the session is waiting for operator input. */
export type InteractionInputRequested = EventEnvelope<
  "interaction.input_requested",
  {
    request_kind: "permission";
    tool_name?: string;
    reason?: string;
  }
>;

export type TurnStop = EventEnvelope<
  "turn.stop",
  {
    tool_call_count: number;
    text_length: number;
    status_box_present: boolean; // adapter sets via transcript scan for `┌─ agent-` prefix
    /** Strict variant of status_box_present: assistant text blocks only, so a
     * tool_result carrying the box (the status command's own output) does not
     * count. Shadow telemetry while the rule-2/3 detector decision is open;
     * the Stop verdict does not read it yet. */
    status_box_present_strict?: boolean;
    /** Whether the session's suggested name is satisfied as of this turn:
     * either this reply showed it, or an earlier reply did. Present whenever a
     * suggested name exists, since the Stop verdict reads it per turn. */
    session_name_present?: boolean;
    /** Which suggested name `session_name_present` refers to. A projector
     * rebuild attributes the sighting to this name instead of to whichever
     * name is current during the replay. */
    session_name_present_for?: string;
    /** Shadow telemetry for Windows-hosted Codex workspaces: Markdown link
     * destinations that still use the Linux coordination root. */
    wsl_linux_file_link_count?: number;
    /** Up to three bounded examples for diagnosing the mismatches locally. */
    wsl_linux_file_link_examples?: string[];
  }
>;

/** The evaluated end-turn policy outcome. One row per Stop evaluation makes
 * the future bounce denominator explicit and keeps repeated remediation nags
 * from being mistaken for additional human turns. */
export type StopVerdict = EventEnvelope<
  "stop.verdict",
  {
    allow: boolean;
    rule: string;
    reason?: string;
    enforcement_mode: "enforced" | "observe_only" | "exempt" | "fail_open";
    eligible: boolean;
    nag_delivered: boolean;
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
    /** SHA-256(tool name + canonical exact pre-clamp input). */
    input_hash?: string;
    /** SHA-256 of a recognized semantic target (path, URL, or query). */
    target_hash?: string;
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

// Context continuity
export type ContextSampled = EventEnvelope<
  "context.sampled",
  {
    model?: string;
    used_tokens?: number;
    window_tokens?: number;
    used_percent?: number;
    telemetry_source: "hook" | "native_event" | "result" | "transcript" | "estimate";
    confidence: "exact" | "reported" | "estimated";
  }
>;

export type ContextCheckpointCreated = EventEnvelope<
  "context.checkpoint.created",
  {
    capsule_id: string;
    generation: number;
    path: string;
    reason: "manual" | "pressure" | "pre_compact" | "session_end";
    reused: boolean;
  }
>;

export type ContextCompactionStarted = EventEnvelope<
  "context.compaction.started",
  {
    trigger?: string;
    pre_tokens?: number;
  }
>;

export type ContextCompactionCompleted = EventEnvelope<
  "context.compaction.completed",
  {
    trigger?: string;
    pre_tokens?: number;
    post_tokens?: number;
  }
>;

export type ContextRecoveryInjected = EventEnvelope<
  "context.recovery.injected",
  {
    capsule_id: string;
    generation: number;
    injection_event: "SessionStart" | "UserPromptSubmit";
  }
>;

// File claims
export type ClaimAcquire = EventEnvelope<
  "claim.acquire",
  {
    path: string;
    mode: "read" | "write";
    finalization?: {
      disposition: "git" | "output";
      root: string;
    };
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
    /** True exactly when this call produced the session name (first non-empty
     * declaration of a human-facing session); never true with a null name. */
    first_of_session?: boolean;
    /** The name produced by this call, for the Stop-hook naming rule. */
    suggested_session_name?: string | null;
  }
>;

export type StateTaskState = EventEnvelope<
  "state.task_state",
  {
    state: "active" | "blocked" | "done";
    reason?: string;
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

export type StateJournalAppend = EventEnvelope<
  "state.journal_append",
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

/** A live session adopted a durable persona/role. The event is authoritative
 * for replay; `.name-history` carries the same binding for heartbeat healing. */
export type IdentityAssumed = EventEnvelope<
  "identity.assumed",
  {
    name: string;
    agent_id: string;
    previous_name?: string;
    previous_agent_id?: string;
  }
>;

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
 * A heartbeat file was removed by stale-sweep or an operator kill. Symmetric
 * with `health.heartbeat_heal` so the full lifecycle (created → healed →
 * swept) is auditable from the event stream alone. Sweeps were silent before,
 * which made "why did this agent vanish?" un-answerable without guesswork.
 * `reason`: "stale" (last_heartbeat past the freshness cutoff) | "unparseable"
 * (JSON.parse failed AND mtime was old) | "missing_ts" (no last_heartbeat AND
 * mtime was old) | "killed" (operator `kill-heartbeat` / `agents heal --kind
 * kill`). Fresh-mtime files are never auto-swept regardless of content.
 */
export type HealthHeartbeatSwept = EventEnvelope<
  "health.heartbeat_swept",
  {
    reason: "stale" | "unparseable" | "missing_ts" | "killed";
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

/** Advisory run-quality status transition. Never an execution verdict. */
export type HealthRunQualityChanged = EventEnvelope<
  "health.run_quality_changed",
  {
    previous_status: "unknown" | "healthy" | "attention" | "critical";
    status: "unknown" | "healthy" | "attention" | "critical";
    signal_ids: string[];
    evidence_watermark?: string;
    reason: "evidence" | "deadline" | "config_changed" | "insufficient_evidence";
  }
>;

/** A malformed coord.run_quality object disabled evaluation for its digest. */
export type HealthRunQualityConfigInvalid = EventEnvelope<
  "health.run_quality_config_invalid",
  {
    config_digest: string;
    reason_codes: string[];
    fallback: "off";
  }
>;

// ── Discriminated union over every event_type ────────────────────────────────

export type Event =
  | SessionStart
  | SessionEnd
  | SubagentStart
  | SubagentStop
  | UserPromptSubmit
  | InteractionInputRequested
  | TurnStop
  | StopVerdict
  | CommandStart
  | CommandOutput
  | CommandEnd
  | Narration
  | ToolPreUse
  | ToolPostUse
  | ToolPostUseFailure
  | ToolOutputChunk
  | ImageCaptured
  | ContextSampled
  | ContextCheckpointCreated
  | ContextCompactionStarted
  | ContextCompactionCompleted
  | ContextRecoveryInjected
  | ClaimAcquire
  | ClaimRelease
  | ClaimConflict
  | StateTaskSet
  | StateTaskState
  | StateStatusChecked
  | StateJournalAppend
  | StatePresenceChange
  | StateHeartbeat
  | IdentityAssumed
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
  | HealthVerdictFailure
  | HealthRunQualityChanged
  | HealthRunQualityConfigInvalid;

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
