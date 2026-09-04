import type { CodecPanelScene, CodecSourceEvidence } from "./contracts";

type CodecTiming = NonNullable<CodecPanelScene["timing"]>;
type TimingBucket = CodecTiming["value"]["current_bucket"];

const SESSION_BOUNDARIES = new Set(["session.started", "session.resumed"]);

function eventTime(event: CodecSourceEvidence): number {
  return Date.parse(event.ts);
}

function timingBucket(event: CodecSourceEvidence): Exclude<TimingBucket, "stopped"> | undefined {
  switch (event.event_type) {
    case "turn.started":
    case "wait.ended":
      return "working";
    case "session.started":
    case "session.resumed":
    case "turn.completed":
    case "wait.started":
    case "session.ended":
      return "idle";
    default:
      return undefined;
  }
}

/**
 * Project session wall-clock accounting from sanitized lifecycle evidence.
 * Working time follows active turns but explicit waits count as idle. The two
 * buckets therefore partition the complete measured session duration.
 */
export function projectCodecTimings(
  events: readonly CodecSourceEvidence[],
  now: string,
): Map<string, CodecTiming> {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return new Map();

  const byInstance = new Map<string, CodecSourceEvidence[]>();
  const seen = new Set<string>();
  for (const event of events) {
    const ts = eventTime(event);
    if (seen.has(event.event_id) || !Number.isFinite(ts) || ts > nowMs) continue;
    seen.add(event.event_id);
    const rows = byInstance.get(event.instance_id) ?? [];
    rows.push(event);
    byInstance.set(event.instance_id, rows);
  }

  const timings = new Map<string, CodecTiming>();
  for (const [instanceId, unordered] of byInstance) {
    const ordered = unordered.toSorted(
      (left, right) =>
        eventTime(left) - eventTime(right) || left.event_id.localeCompare(right.event_id),
    );
    let boundaryIndex = -1;
    for (let index = 0; index < ordered.length; index += 1) {
      if (SESSION_BOUNDARIES.has(ordered[index]!.event_type)) boundaryIndex = index;
    }
    if (boundaryIndex < 0) continue;

    const scoped = ordered.slice(boundaryIndex);
    const started = scoped[0]!;
    const startedAt = eventTime(started);
    const ended = scoped.find((event) => event.event_type === "session.ended");
    const endedAt = ended ? eventTime(ended) : nowMs;
    const measuredAt = Math.max(startedAt, Math.min(nowMs, endedAt));

    let cursor = startedAt;
    let bucket: Exclude<TimingBucket, "stopped"> = "idle";
    let workingMs = 0;
    let idleMs = 0;
    for (const event of scoped) {
      const ts = Math.max(cursor, Math.min(measuredAt, eventTime(event)));
      const elapsed = ts - cursor;
      if (bucket === "working") workingMs += elapsed;
      else idleMs += elapsed;
      cursor = ts;
      bucket = timingBucket(event) ?? bucket;
      if (event === ended) break;
    }
    const remaining = measuredAt - cursor;
    if (bucket === "working") workingMs += remaining;
    else idleMs += remaining;

    const turnStarts = scoped.filter(
      (event) => event.event_type === "turn.started" && eventTime(event) <= measuredAt,
    );
    const lastTurnStarted = turnStarts.at(-1);
    let lastTurnDurationMs: number | undefined;
    let lastTurnActive = false;
    let turnTerminal: CodecSourceEvidence | undefined;
    if (lastTurnStarted) {
      const turnStartedAt = eventTime(lastTurnStarted);
      turnTerminal = scoped.find(
        (event) =>
          event.event_type === "turn.completed" &&
          eventTime(event) >= turnStartedAt &&
          (!lastTurnStarted.turn_id || !event.turn_id || event.turn_id === lastTurnStarted.turn_id),
      );
      const turnEndedAt = turnTerminal ? eventTime(turnTerminal) : measuredAt;
      lastTurnDurationMs = Math.max(0, turnEndedAt - turnStartedAt);
      lastTurnActive = !turnTerminal && !ended;
    }

    const evidenceIds = [started.event_id];
    if (lastTurnStarted) evidenceIds.push(lastTurnStarted.event_id);
    if (turnTerminal) evidenceIds.push(turnTerminal.event_id);
    if (ended) evidenceIds.push(ended.event_id);
    timings.set(instanceId, {
      value: {
        session_duration_ms: Math.max(0, measuredAt - startedAt),
        ...(lastTurnDurationMs === undefined ? {} : { last_turn_duration_ms: lastTurnDurationMs }),
        working_duration_ms: workingMs,
        idle_duration_ms: idleMs,
        session_active: !ended,
        last_turn_active: lastTurnActive,
        current_bucket: ended ? "stopped" : bucket,
      },
      provenance: "event",
      confidence: "high",
      observed_at: new Date(measuredAt).toISOString(),
      evidence_event_ids: evidenceIds,
    });
  }
  return timings;
}
