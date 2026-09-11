import type { EventV3 } from "../events/v3/contract.ts";
import { liveInstanceIdV3 } from "../events/v3/live-routing.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import type { LineChanges } from "../events/v3/tool-line-changes.ts";

export interface TurnChanges extends LineChanges {
  measured_tools: number;
  unmeasured_tools: number;
}

/** Sum edit activity, not a net workspace diff. Commits cannot erase it. */
export function resolveTurnChanges(
  events: readonly EventV3[],
  instanceId: string,
  now = Date.now(),
): TurnChanges | null {
  const owner = liveInstanceIdV3(instanceId);
  const own = events.filter(
    (event) => event.scope.instance_id === owner && Date.parse(event.time.observed_at) <= now,
  );
  const starts = own.filter((event) => event.event_type === "turn.started");
  const newest = starts.at(-1);
  if (!newest || !("generation_id" in newest.scope)) return null;
  const generation = newest.scope.generation_id;
  let index = starts.length - 1;
  let restarts = 0;
  while (
    index > 0 &&
    restarts < 8 &&
    starts[index]?.event_type === "turn.started" &&
    starts[index]?.payload.stop_remediation === true
  ) {
    const previous = starts[index - 1]!;
    if (!("generation_id" in previous.scope) || previous.scope.generation_id !== generation) break;
    index--;
    restarts++;
  }
  const selected = starts.slice(index);
  const ids = new Set(
    selected.map((event) => ("turn_id" in event.scope ? event.scope.turn_id : undefined)),
  );
  const from = Date.parse(selected[0]!.time.observed_at);
  const tools = own.filter(
    (event) =>
      "generation_id" in event.scope &&
      event.scope.generation_id === generation &&
      "turn_id" in event.scope &&
      ids.has(event.scope.turn_id) &&
      Date.parse(event.time.observed_at) >= from,
  );
  const result: TurnChanges = { added: 0, removed: 0, measured_tools: 0, unmeasured_tools: 0 };
  const completed = new Set<string>();
  for (const event of tools) {
    if (event.event_type !== "tool.completed") continue;
    const span = event.payload.span.span_id;
    if (completed.has(span)) continue;
    completed.add(span);
    const changes = event.payload.line_changes;
    if (event.payload.outcome === "succeeded" && changes?.state === "observed") {
      result.added += changes.value.added;
      result.removed += changes.value.removed;
      result.measured_tools++;
    } else result.unmeasured_tools++;
  }
  for (const event of tools) {
    const span = (event.links as { span_id?: string }).span_id;
    if (event.event_type === "tool.requested" && span && !completed.has(span)) {
      completed.add(span);
      result.unmeasured_tools++;
    }
  }
  // No delivered tool evidence cannot prove no file changes occurred.
  return result.measured_tools + result.unmeasured_tools > 0 ? result : null;
}

export function formatTurnChanges(changes: TurnChanges | null): string {
  if (!changes || changes.measured_tools === 0) return "unavailable (no measured edits)";
  return `+${changes.added} / -${changes.removed} lines${changes.unmeasured_tools > 0 ? " (partial; unmeasured tools)" : " (recorded edits)"}`;
}

export function turnChangesStatusRow(target: { coordRoot: string; instanceId: string }): {
  value: string;
  changes: TurnChanges | null;
} {
  let changes: TurnChanges | null = null;
  try {
    const ledger = readLedgerV3(target.coordRoot);
    if (ledger.complete)
      changes = resolveTurnChanges(
        ledger.events.map((item) => item.event),
        target.instanceId,
      );
  } catch {
    /* Status remains available when evidence is missing. */
  }
  return { value: formatTurnChanges(changes), changes };
}
