import { type EventV3ActiveTailV3, readEventV3ActiveTailV3 } from "../events/v3/reader.ts";
import { inspectEventV3QueueV3 } from "../events/v3/writer.ts";
import type { SupervisorCapability, SupervisorSourceReference } from "../supervisor/contract.ts";

export interface CoordinationHealthDiagnostic {
  code: "malformed_json" | "invalid_contract";
  byte_offset: number;
  segment_ordinal: number;
  event_id?: string;
}

export interface CoordinationHealthSnapshot {
  observed_at: string;
  capability: SupervisorCapability;
  recent_events: readonly SupervisorSourceReference[];
  diagnostics: readonly CoordinationHealthDiagnostic[];
  omitted_event_count: number;
}

const MAX_EVENT_REFERENCES = 64;
const MAX_DIAGNOSTICS = 16;
const MAX_TAIL_BYTES = 256 * 1_024;

/** Read bounded V3 references without retaining event payloads or the full ledger reader. */
export function collectCoordinationHealthSnapshot(
  coordRoot: string,
  now = new Date(),
): CoordinationHealthSnapshot {
  const observedAt = now.toISOString();
  let tail: EventV3ActiveTailV3;
  try {
    tail = readEventV3ActiveTailV3(coordRoot, MAX_TAIL_BYTES);
  } catch {
    return unavailable(observedAt, "tail-read-failed", "error");
  }
  if (tail.status === "missing") return unavailable(observedAt, "ledger-missing");
  if (tail.status === "unsafe") return unavailable(observedAt, "ledger-unsafe");
  try {
    const start = tail.start;
    const lines = tail.bytes.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    const completeLines = lines.filter((line) => line.length > 0);
    const diagnostics: CoordinationHealthDiagnostic[] = [];
    const references: SupervisorSourceReference[] = [];
    let byteOffset = start;
    for (const line of completeLines) {
      const reference = parseReference(line);
      if (reference) references.push(reference);
      else if (diagnostics.length < MAX_DIAGNOSTICS) {
        diagnostics.push({
          code: line.trimStart().startsWith("{") ? "invalid_contract" : "malformed_json",
          byte_offset: byteOffset,
          segment_ordinal: 1,
        });
      }
      byteOffset += Buffer.byteLength(line) + 1;
    }
    const recent = references.slice(-MAX_EVENT_REFERENCES);
    return available(
      observedAt,
      recent,
      diagnostics,
      Math.max(0, references.length - recent.length) + (start > 0 ? 1 : 0),
    );
  } catch {
    return unavailable(observedAt, "tail-read-failed", "error");
  }
}

function parseReference(line: string): SupervisorSourceReference | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const contract = object(value.contract);
    const time = object(value.time);
    const producer = object(value.producer);
    if (
      contract.major !== 3 ||
      typeof value.event_id !== "string" ||
      typeof value.event_type !== "string" ||
      typeof time.observed_at !== "string" ||
      typeof producer.sequence !== "number" ||
      !Number.isSafeInteger(producer.sequence)
    )
      return undefined;
    return {
      id: `v3:${value.event_id}`,
      source_kind: "coordination.v3",
      source_id: value.event_type,
      record_id: value.event_id,
      sequence: producer.sequence,
      schema_version: 3,
      observed_at: time.observed_at,
      capability: "supported",
    };
  } catch {
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function available(
  observedAt: string,
  recentEvents: readonly SupervisorSourceReference[],
  diagnostics: readonly CoordinationHealthDiagnostic[],
  omittedEventCount: number,
): CoordinationHealthSnapshot {
  const state = diagnostics.length === 0 ? "supported" : "partial";
  return {
    observed_at: observedAt,
    capability: {
      source_kind: "coordination.v3.references",
      state,
      ...(state === "partial" ? { reason_code: diagnostics[0]?.code ?? "tail-invalid" } : {}),
    },
    recent_events: recentEvents.map((reference) => ({ ...reference, capability: state })),
    diagnostics,
    omitted_event_count: omittedEventCount,
  };
}

function unavailable(
  observedAt: string,
  reasonCode: string,
  state: "unsupported" | "error" = "unsupported",
): CoordinationHealthSnapshot {
  return {
    observed_at: observedAt,
    capability: { source_kind: "coordination.v3.references", state, reason_code: reasonCode },
    recent_events: [],
    diagnostics: [],
    omitted_event_count: 0,
  };
}

/** Queued rows the writer's door declines for one generation and one reason. */
export interface EventQueueWaitingGroupV3 {
  generation_id: string;
  instance_id?: string;
  reason: string;
  count: number;
  first_waiting_sequence?: number;
  oldest_age_ms: number;
}

/** Files the drain renamed aside, grouped by generation and reason. */
export interface EventQueueSetAsideGroupV3 {
  generation_id?: string;
  reason: string;
  count: number;
  oldest_age_ms: number;
}

export interface EventQueueHealthV3 {
  waiting_total: number;
  set_aside_total: number;
  waiting: EventQueueWaitingGroupV3[];
  set_aside: EventQueueSetAsideGroupV3[];
}

/**
 * Summarize the ledger queue for health reports: valid rows the door will not
 * admit yet and files it set aside, per generation and reason, with the first
 * waiting producer sequence and the age of the oldest.
 */
export function collectEventQueueHealthV3(
  coordRoot: string,
  nowMs = Date.now(),
  options: { generationId?: string } = {},
): EventQueueHealthV3 {
  const inspection = inspectEventV3QueueV3(coordRoot, options);
  const waiting = new Map<string, EventQueueWaitingGroupV3>();
  for (const row of inspection.waiting) {
    const generationId = row.generation_id ?? "unscoped";
    const key = `${generationId}\0${row.reason}`;
    const age = Math.max(0, nowMs - row.queued_at_ms);
    const group = waiting.get(key);
    if (!group) {
      waiting.set(key, {
        generation_id: generationId,
        ...(row.instance_id ? { instance_id: row.instance_id } : {}),
        reason: row.reason,
        count: 1,
        ...(row.producer_sequence !== undefined
          ? { first_waiting_sequence: row.producer_sequence }
          : {}),
        oldest_age_ms: age,
      });
      continue;
    }
    group.count += 1;
    group.oldest_age_ms = Math.max(group.oldest_age_ms, age);
    if (
      row.producer_sequence !== undefined &&
      (group.first_waiting_sequence === undefined ||
        row.producer_sequence < group.first_waiting_sequence)
    ) {
      group.first_waiting_sequence = row.producer_sequence;
    }
  }
  const setAside = new Map<string, EventQueueSetAsideGroupV3>();
  for (const file of inspection.set_aside) {
    const key = `${file.generation_id ?? ""}\0${file.reason}`;
    const age = Math.max(0, nowMs - file.set_aside_at_ms);
    const group = setAside.get(key);
    if (group) {
      group.count += 1;
      group.oldest_age_ms = Math.max(group.oldest_age_ms, age);
    } else {
      setAside.set(key, {
        ...(file.generation_id ? { generation_id: file.generation_id } : {}),
        reason: file.reason,
        count: 1,
        oldest_age_ms: age,
      });
    }
  }
  return {
    waiting_total: inspection.waiting.length,
    set_aside_total: inspection.set_aside.length,
    waiting: [...waiting.values()],
    set_aside: [...setAside.values()],
  };
}

/**
 * The notice a session sees when its own events wait in the ledger queue, or
 * undefined when none do. `binName` is the command name to print.
 */
export function waitingEventsNoticeV3(
  coordRoot: string,
  generationId: string,
  binName: string,
): string | undefined {
  const queue = collectEventQueueHealthV3(coordRoot, Date.now(), { generationId });
  const first = queue.waiting[0];
  if (!first) return undefined;
  const sequence =
    first.first_waiting_sequence !== undefined
      ? `, first at producer sequence ${first.first_waiting_sequence}`
      : "";
  return (
    `${queue.waiting_total} event(s) of generation ${generationId} are waiting in the ledger queue ` +
    `because the ledger would reject them now (reason ${first.reason}${sequence}); ` +
    "this session's coordination changes are applied locally but not yet recorded. " +
    "Start a new session, or wait for the next epoch rotation, which re-records this session's state; " +
    `\`${binName} agents health\` lists waiting events`
  );
}
