/**
 * End-of-turn ritual verdict derived from the authoritative V3 event ledger.
 *
 * V3 keeps prompt and reply bodies private. The hook producer records only the
 * structural observations needed here: whether the reply showed the status box
 * and current session name, and whether a prompt was emitted by Harnery's own
 * Cursor remediation channel. Task and status evidence comes from the existing
 * `coord.task_changed` and `coord.status_observed` events.
 */

import {
  agentsRequireGitFinalization,
  endOfTurnStatusCommand,
  resolveBinName,
} from "../../config.ts";
import type { EventV3 } from "../../events/v3/contract.ts";
import { readEventV3ControlState } from "../../events/v3/control.ts";
import { liveInstanceIdV3 } from "../../events/v3/live-routing.ts";
import { readLedgerV3 } from "../../events/v3/reader.ts";
import { readLiveCoordinationRow } from "../state/live-coordination-view.ts";

export type { VerdictResult } from "./verdict.ts";

import type { VerdictResult } from "./verdict.ts";

export interface StopHookRequest {
  rule: "stop-hook";
  instance_id: string;
  session_id?: string;
  adapter?: string;
  now_ms?: number;
  turn_window?: { start_ms: number; end_ms: number };
  bypass?: boolean;
  workflow_child?: boolean;
}

export const STOP_REMEDIATION_MARKER = "[harnery:stop-remediation";

const MAX_REMEDIATION_WALK_BACK = 16;

export function evaluateStopHook(coordRoot: string, req: StopHookRequest): VerdictResult {
  const unconditional = unconditionalVerdict(req);
  if (unconditional) return unconditional;

  const control = readEventV3ControlState(coordRoot);
  if (control.state !== "candidate" && control.state !== "active") {
    return evidenceUnavailable(
      `V3 control state is ${control.state}; authoritative Stop evidence is unavailable`,
    );
  }

  try {
    const ledger =
      control.state === "candidate"
        ? readLedgerV3(coordRoot, { authority: "candidate" })
        : readLedgerV3(coordRoot);
    if (!ledger.complete || ledger.diagnostics.length > 0) {
      return evidenceUnavailable(
        "V3 ledger integrity is not authority-safe; Stop remains fail-open",
      );
    }
    return evaluateStopHookV3Events(
      coordRoot,
      req,
      ledger.events.map(({ event }) => event),
    );
  } catch {
    return evidenceUnavailable("V3 ledger is not readable; Stop remains fail-open");
  }
}

/** Pure V3 evaluator used by replay and regression tests after authority checks. */
export function evaluateStopHookV3Events(
  coordRoot: string,
  req: StopHookRequest,
  events: readonly EventV3[],
): VerdictResult {
  const unconditional = unconditionalVerdict(req);
  if (unconditional) return unconditional;

  const owner = liveInstanceIdV3(req.instance_id);
  const endMs = req.turn_window?.end_ms ?? req.now_ms ?? Date.now();
  const currentTerminal = [...events]
    .reverse()
    .find(
      (event) =>
        event.event_type === "turn.completed" &&
        event.scope.instance_id === owner &&
        eventTimeMs(event) <= endMs,
    );
  if (currentTerminal?.event_type !== "turn.completed") {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.no_history",
      reason: "no authoritative V3 turn terminal for this owner; nothing to evaluate",
    };
  }

  if (!("generation_id" in currentTerminal.scope)) {
    return evidenceUnavailable("turn.completed has no V3 generation scope; Stop remains fail-open");
  }
  const generationId = currentTerminal.scope.generation_id;
  const ownerEvents = events.filter(
    (event) =>
      event.scope.instance_id === owner &&
      "generation_id" in event.scope &&
      event.scope.generation_id === generationId,
  );
  const startMs =
    req.turn_window?.start_ms ??
    resolveTurnStartMs(ownerEvents, endMs, Math.max(0, endMs - 5 * 60 * 1000));
  const inTurn = ownerEvents.filter((event) => {
    const time = eventTimeMs(event);
    return Number.isFinite(time) && time >= startMs && time <= endMs;
  });

  const usedTool = inTurn.some((event) => event.event_type === "tool.requested");
  const statusEvents = inTurn.filter(
    (event) =>
      event.event_type === "coord.status_observed" && event.payload.subject_instance_id === owner,
  );
  const statusChecked = statusEvents.length > 0;
  const requiredStatusChecked = agentsRequireGitFinalization(coordRoot)
    ? statusEvents.some(
        (event) =>
          event.event_type === "coord.status_observed" &&
          event.payload.status === "end_turn_checked",
      )
    : statusChecked;
  const taskSet = inTurn.some(
    (event) =>
      event.event_type === "coord.task_changed" && event.payload.subject_instance_id === owner,
  );

  const turnTerminals = inTurn.filter(
    (event): event is Extract<EventV3, { event_type: "turn.completed" }> =>
      event.event_type === "turn.completed",
  );
  const latestTerminal = turnTerminals.at(-1);
  const latestBox = observedBoolean(latestTerminal?.payload.ritual?.status_box_present_strict);
  if (req.adapter !== "cursor" && latestBox === undefined) {
    return evidenceUnavailable(
      "turn.completed has no observed V3 assistant-text status-box result; Stop remains fail-open",
    );
  }

  const ackPresent = req.adapter === "cursor" ? requiredStatusChecked : latestBox === true;
  const ackBlock =
    req.adapter === "cursor"
      ? () => rule13Block(coordRoot, req.session_id)
      : () => rule23Block(coordRoot, req.session_id);

  // Pure prose turns keep the human-visible acknowledgement but do not require
  // task or final-status mutations. This preserves the pre-V3 policy exactly.
  if (!usedTool) {
    if (!ackPresent) return ackBlock();
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.pure_prose_pass",
      reason: "no tool calls this turn; task and final-status mutations were not required",
    };
  }

  if (!requiredStatusChecked) return rule13Block(coordRoot, req.session_id);
  if (!ackPresent) return ackBlock();
  if (!taskSet) return rule33Block(coordRoot, req.session_id);

  // Claude Code can prove session-name presentation from assistant-only text.
  // Cursor cannot expose that text and Codex returned observe-only above.
  if (req.adapter !== "cursor") {
    const naming = turnTerminals
      .map((event) => observedNaming(event.payload.ritual?.session_name))
      .filter((value): value is { required: boolean; present: boolean } => value !== undefined);
    if (
      naming.some(({ required }) => required) &&
      !naming.some(({ present }) => present) &&
      !sessionNameSeenStamped(coordRoot, req.instance_id)
    ) {
      return sessionNameBlock(coordRoot, req.instance_id);
    }
  }

  return { allow: true, exit_code: 0, rule: "stop-hook.pass" };
}

function unconditionalVerdict(req: StopHookRequest): VerdictResult | undefined {
  if (req.bypass) {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.bypass",
      reason: "HARNERY_AGENT_COORD_BYPASS_STOP=1",
    };
  }
  if (req.workflow_child) {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.workflow_child",
      reason: "HARNERY_WORKFLOW_CHILD=1: headless workflow child; ritual not applicable",
    };
  }
  if (req.adapter === "codex") {
    return {
      allow: true,
      exit_code: 0,
      rule: "stop-hook.codex_observe_only",
      reason: "Codex Stop continuations must not replace the user-facing answer",
    };
  }
  return undefined;
}

function resolveTurnStartMs(
  ownerEvents: readonly EventV3[],
  nowMs: number,
  fallbackMs: number,
): number {
  const turns = ownerEvents.filter(
    (event): event is Extract<EventV3, { event_type: "turn.started" }> =>
      event.event_type === "turn.started" && eventTimeMs(event) <= nowMs,
  );
  if (turns.length === 0) return fallbackMs;

  let index = turns.length - 1;
  let hops = 0;
  while (index > 0 && hops < MAX_REMEDIATION_WALK_BACK) {
    const turn = turns[index];
    if (!turn?.payload.stop_remediation) break;
    index -= 1;
    hops += 1;
  }
  return eventTimeMs(turns[index]!);
}

function eventTimeMs(event: EventV3): number {
  return Date.parse(event.time.observed_at);
}

function observedBoolean(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const observation = value as { state?: unknown; value?: unknown };
  return observation.state === "observed" && typeof observation.value === "boolean"
    ? observation.value
    : undefined;
}

function observedNaming(value: unknown): { required: boolean; present: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const observation = value as { state?: unknown; value?: unknown };
  if (
    observation.state !== "observed" ||
    !observation.value ||
    typeof observation.value !== "object" ||
    Array.isArray(observation.value)
  ) {
    return undefined;
  }
  const naming = observation.value as { required?: unknown; present?: unknown };
  return typeof naming.required === "boolean" && typeof naming.present === "boolean"
    ? { required: naming.required, present: naming.present }
    : undefined;
}

function evidenceUnavailable(reason: string): VerdictResult {
  return {
    allow: true,
    exit_code: 0,
    rule: "stop-hook.v3_evidence_unavailable",
    reason,
  };
}

/**
 * Remediation commands carry `--session-id` when the session id is known: the
 * remediating tool call may not descend from a pid-map-registered anchor
 * (headless children, Cursor shells), and a ppid-walk that resolves to a
 * DIFFERENT owner records evidence this verdict will never see — the block
 * then repeats forever while the agent complies every time.
 */
function sessionIdSuffix(sessionId?: string): string {
  return sessionId ? ` --session-id ${sessionId}` : "";
}

function rule13Block(coordRoot?: string, sessionId?: string): VerdictResult {
  const missingEvidence = agentsRequireGitFinalization(coordRoot)
    ? "no end_turn_checked coord.status_observed event found in this turn"
    : "no coord.status_observed event found in this turn";
  return {
    allow: false,
    exit_code: 2,
    rule: "stop-hook.rule_1_3",
    reason: `End-of-turn rule (1/3): ${missingEvidence}; run \`${endOfTurnStatusCommand(coordRoot)}${sessionIdSuffix(sessionId)}\` as your last tool call.`,
  };
}

function rule23Block(coordRoot?: string, sessionId?: string): VerdictResult {
  return {
    allow: false,
    exit_code: 2,
    rule: "stop-hook.rule_2_3",
    reason: `End-of-turn rule (2/3): turn.completed did not observe the agent-status box in your reply text. Paste the \`${endOfTurnStatusCommand(coordRoot)}${sessionIdSuffix(sessionId)}\` output verbatim as a fenced code block (the \`┌─ agent-\` prefix is the detection signal).`,
  };
}

/**
 * A remediation stop cannot land a fresh `turn.completed`: the turn's first
 * stop closed the turn span, continuations open no new one, so the recorder
 * ignores their terminals. When that first terminal lost the transcript flush
 * race and recorded `present: false`, in-window ledger evidence can never
 * change, and the naming rule blocked every retry forever. The sighting stamp
 * on the live coordination row is the durable record that the current
 * suggested name WAS shown in an assistant reply (session-name-presence.ts
 * writes it on the first sighting), so honor it before blocking. Ledger
 * evidence stays primary; the stamp is consulted only after in-window
 * terminals said absent.
 */
function sessionNameSeenStamped(coordRoot: string, instanceId: string): boolean {
  try {
    const row = readLiveCoordinationRow(coordRoot, instanceId);
    return (
      typeof row?.suggested_session_name === "string" &&
      row.suggested_session_name.length > 0 &&
      row.session_name_seen_for === row.suggested_session_name
    );
  } catch {
    return false;
  }
}

function sessionNameBlock(coordRoot: string, instanceId: string): VerdictResult {
  let name: string | undefined;
  try {
    name = readLiveCoordinationRow(coordRoot, instanceId)?.suggested_session_name;
  } catch {
    // The ledger evidence still authorizes the block; the cache is UX only.
  }
  const instruction = name
    ? `Reproduce it by itself in a fenced code block: ${name}`
    : `Run \`${resolveBinName(coordRoot)} agents suggest-name\`, then reproduce its output by itself in a fenced code block.`;
  return {
    allow: false,
    exit_code: 2,
    rule: "stop-hook.session_name",
    reason: `Session-naming rule: V3 observed that the current session name was required but absent. ${instruction}`,
  };
}

function rule33Block(coordRoot?: string, sessionId?: string): VerdictResult {
  return {
    allow: false,
    exit_code: 2,
    rule: "stop-hook.rule_3_3",
    reason: `End-of-turn rule (3/3): no coord.task_changed event found in this turn; run \`${resolveBinName(coordRoot)} agents set-task${sessionIdSuffix(sessionId)} "<short focus>"\` to declare what you're working on. Pass an empty string if the turn was purely conversational.`,
  };
}
