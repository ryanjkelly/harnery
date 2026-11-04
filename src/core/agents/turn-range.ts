import type { EventV3 } from "../events/v3/contract.ts";
import { liveInstanceIdV3 } from "../events/v3/live-routing.ts";

export const MAX_TURN_CONTINUATIONS = 16;

type TurnStart = Extract<EventV3, { event_type: "turn.started" }> & {
  scope: { generation_id: string; turn_id: string };
};

export interface TurnRange {
  start: TurnStart;
  latest: TurnStart;
  starts: TurnStart[];
  generationId: string;
  startMs: number;
  latestStartMs: number;
  continuationCount: number;
  /** Late recoveries of an older turn cannot replace a newer operator turn. */
  ignoredTurnIds: ReadonlySet<string>;
}

/** Resolve one logical turn using explicit, adjacent continuation links. */
export function resolveTurnRange(
  events: readonly EventV3[],
  instanceId: string,
  now = Date.now(),
): TurnRange | null {
  const owner = liveInstanceIdV3(instanceId);
  const starts = events.filter(
    (event): event is TurnStart =>
      event.event_type === "turn.started" &&
      event.scope.instance_id === owner &&
      "generation_id" in event.scope &&
      "turn_id" in event.scope &&
      typeof event.scope.turn_id === "string" &&
      Date.parse(event.time.observed_at) <= now,
  );
  const ignoredTurnIds = new Set<string>();
  const seenByGeneration = new Map<string, Set<string>>();
  const accepted: TurnStart[] = [];
  for (const current of starts) {
    const seen = seenByGeneration.get(current.scope.generation_id) ?? new Set<string>();
    seenByGeneration.set(current.scope.generation_id, seen);
    const link = current.payload.continues_turn_id;
    const previous = accepted.at(-1);
    if (link) {
      const adjacent =
        previous?.scope.generation_id === current.scope.generation_id &&
        previous.scope.turn_id === link;
      const knownEarlier = seen.has(link);
      seen.add(current.scope.turn_id);
      if (!adjacent && knownEarlier) {
        ignoredTurnIds.add(current.scope.turn_id);
        continue;
      }
    }
    seen.add(current.scope.turn_id);
    accepted.push(current);
  }
  if (accepted.length === 0) return null;

  const latestIndex = accepted.length - 1;
  const latest = accepted[latestIndex]!;
  let firstIndex = latestIndex;
  let continuationCount = 0;
  while (firstIndex > 0 && continuationCount < MAX_TURN_CONTINUATIONS) {
    const current = accepted[firstIndex]!;
    const previous = accepted[firstIndex - 1]!;
    if (
      !current.payload.continues_turn_id ||
      current.payload.continues_turn_id !== previous.scope.turn_id ||
      current.scope.generation_id !== previous.scope.generation_id
    ) {
      break;
    }
    firstIndex--;
    continuationCount++;
  }

  const start = accepted[firstIndex]!;
  return {
    start,
    latest,
    starts: accepted.slice(firstIndex, latestIndex + 1),
    generationId: latest.scope.generation_id,
    startMs: Date.parse(start.time.observed_at),
    latestStartMs: Date.parse(latest.time.observed_at),
    continuationCount,
    ignoredTurnIds,
  };
}
