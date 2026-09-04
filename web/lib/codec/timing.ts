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
  startedAtByInstance: ReadonlyMap<string, string> = new Map(),
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
  const instanceIds = new Set([...byInstance.keys(), ...startedAtByInstance.keys()]);
  for (const instanceId of instanceIds) {
    const unordered = byInstance.get(instanceId) ?? [];
    const ordered = unordered.toSorted(
      (left, right) =>
        eventTime(left) - eventTime(right) || left.event_id.localeCompare(right.event_id),
    );
    let boundaryIndex = -1;
    for (let index = 0; index < ordered.length; index += 1) {
      if (SESSION_BOUNDARIES.has(ordered[index]!.event_type)) boundaryIndex = index;
    }

    const started = boundaryIndex >= 0 ? ordered[boundaryIndex] : undefined;
    const heartbeatStartedAt = Date.parse(startedAtByInstance.get(instanceId) ?? "");
    const boundarySource = started ? "event" : "heartbeat";
    if (!started && (!Number.isFinite(heartbeatStartedAt) || heartbeatStartedAt > nowMs)) continue;

    const startedAt = started ? eventTime(started) : heartbeatStartedAt;
    const scoped = started
      ? ordered.slice(boundaryIndex)
      : ordered.filter((event) => eventTime(event) >= startedAt);
    const ended = scoped.find((event) => event.event_type === "session.ended");
    const endedAt = ended ? eventTime(ended) : nowMs;
    const measuredAt = Math.max(startedAt, Math.min(nowMs, endedAt));

    let cursor = startedAt;
    let bucket: Exclude<TimingBucket, "stopped"> = started ? "idle" : "unknown";
    let observedFromEvent: CodecSourceEvidence | undefined;
    let workingMs = 0;
    let idleMs = 0;
    for (const event of scoped) {
      const ts = Math.max(cursor, Math.min(measuredAt, eventTime(event)));
      const elapsed = ts - cursor;
      if (bucket === "working") workingMs += elapsed;
      else if (bucket === "idle") idleMs += elapsed;
      cursor = ts;
      const nextBucket = timingBucket(event);
      if (nextBucket) {
        if (bucket === "unknown") observedFromEvent = event;
        bucket = nextBucket;
      }
      if (event === ended) break;
    }
    const remaining = measuredAt - cursor;
    if (bucket === "working") workingMs += remaining;
    else if (bucket === "idle") idleMs += remaining;
    const observedFrom = started
      ? undefined
      : (observedFromEvent?.ts ?? new Date(measuredAt).toISOString());

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

    const evidenceIds = new Set<string>();
    if (started) evidenceIds.add(started.event_id);
    if (observedFromEvent) evidenceIds.add(observedFromEvent.event_id);
    if (lastTurnStarted) evidenceIds.add(lastTurnStarted.event_id);
    if (turnTerminal) evidenceIds.add(turnTerminal.event_id);
    if (ended) evidenceIds.add(ended.event_id);
    timings.set(instanceId, {
      value: {
        session_duration_ms: Math.max(0, measuredAt - startedAt),
        ...(lastTurnDurationMs === undefined ? {} : { last_turn_duration_ms: lastTurnDurationMs }),
        working_duration_ms: workingMs,
        idle_duration_ms: idleMs,
        boundary_source: boundarySource,
        ...(observedFrom ? { observed_from: observedFrom } : {}),
        session_active: !ended,
        last_turn_active: lastTurnActive,
        current_bucket: ended ? "stopped" : bucket,
      },
      provenance: started ? "event" : "projection",
      confidence: started ? "high" : "medium",
      observed_at: new Date(measuredAt).toISOString(),
      evidence_event_ids: [...evidenceIds],
    });
  }
  return timings;
}
