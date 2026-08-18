/** What the agent is doing now. `unknown` is evidence-safe, not an error. */
export type AgentActivity = "unknown" | "working" | "needs_input" | "idle";

/** Whether the declared task remains open. Activity never changes this axis. */
export type TaskState = "active" | "blocked" | "done";

/** Raw fields stored in the disposable V3 coordination cache and rebuilt from canonical events. */
export interface SessionStateFields {
  activity?: AgentActivity;
  activity_updated_at?: string;
  activity_source?: string;
  task_state?: TaskState;
  task_state_updated_at?: string;
  task_state_reason?: string;
}

/** Reader-facing state with compatibility defaults applied. */
export interface SessionState extends SessionStateFields {
  activity: AgentActivity;
  task_state: TaskState;
}

export interface SessionStateSelector {
  instance_id?: string;
  session_id?: string;
}

export interface SessionStateEvidenceEvent {
  event_type: EventTypeV3;
  ts: string;
  payload?: Record<string, unknown>;
  instance_id?: string;
  session_id?: string;
}

const TERMINAL_ACTIVITY_EVENTS: ReadonlySet<EventTypeV3> = new Set([
  "session.ended",
  "agent.completed",
  "turn.completed",
]);

/**
 * Apply one canonical event to the two independent state axes.
 *
 * The table is deliberately evidence-only. Output chunks, post-tool events,
 * narration, coordination commands, and elapsed time cannot clear an observed
 * input wait. A command start only counts as progress when the session was
 * already inside an open turn (`working` or `needs_input`).
 */
export function applySessionStateEvent(
  current: Readonly<SessionStateFields>,
  event: SessionStateEvidenceEvent,
): SessionStateFields {
  const next: SessionStateFields = { ...current };

  if (
    event.event_type === "session.started" ||
    event.event_type === "session.resumed" ||
    event.event_type === "agent.started"
  ) {
    setActivity(next, "idle", event);
  } else if (event.event_type === "turn.started" || event.event_type === "tool.requested") {
    setActivity(next, "working", event);
  } else if (event.event_type === "wait.started") {
    setActivity(next, "needs_input", event);
  } else if (event.event_type === "wait.ended") {
    setActivity(next, "working", event);
  } else if (
    event.event_type === "command.started" &&
    (current.activity === "working" || current.activity === "needs_input")
  ) {
    setActivity(next, "working", event);
  } else if (TERMINAL_ACTIVITY_EVENTS.has(event.event_type)) {
    setActivity(next, "idle", event);
  }

  if (event.event_type === "coord.lifecycle_changed") {
    const payload = event.payload ?? {};
    const state = field(payload, "new_state");
    if (state === "active" || state === "blocked" || state === "done") {
      next.task_state = state;
      next.task_state_updated_at = event.ts;
      const reason = field(payload, "reason");
      if (typeof reason === "string" && reason.length > 0) {
        next.task_state_reason = reason;
      } else {
        delete next.task_state_reason;
      }
    }
  }

  return next;
}

/**
 * Rebuild both axes from canonical events after a heartbeat has disappeared.
 * Events may be the whole ledger or an already-filtered session slice.
 */
export function foldSessionState(
  events: readonly SessionStateEvidenceEvent[],
  selector: SessionStateSelector = {},
): SessionState {
  const ordered = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => matches(event, selector))
    .sort((a, b) => timestamp(a.event) - timestamp(b.event) || a.index - b.index);

  let fields: SessionStateFields = {};
  for (const { event } of ordered) fields = applySessionStateEvent(fields, event);

  return {
    ...fields,
    activity: fields.activity ?? "unknown",
    task_state: fields.task_state ?? "active",
  };
}

function setActivity(
  target: SessionStateFields,
  activity: AgentActivity,
  event: SessionStateEvidenceEvent,
): void {
  target.activity = activity;
  target.activity_updated_at = event.ts;
  target.activity_source = event.event_type;
}

function matches(event: SessionStateEvidenceEvent, selector: SessionStateSelector): boolean {
  if (selector.instance_id && event.instance_id !== selector.instance_id) return false;
  if (selector.session_id && event.session_id !== selector.session_id) return false;
  return true;
}

function timestamp(event: SessionStateEvidenceEvent): number {
  const parsed = Date.parse(event.ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function field(data: Record<string, unknown>, key: string): unknown {
  return data[key];
}

import type { EventTypeV3 } from "../../events/v3/contract.ts";
