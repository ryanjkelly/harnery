import type { EventV3 } from "./contract.ts";
import type { CoordinationViewV3 } from "./coordination-view.ts";
import { isDelegationLinkEventV3 } from "./delegation-link-event.ts";

/** One link to write: the parent generation delegated to the child generation. */
export interface DelegationLinkPlanV3 {
  parent_generation_id: `gen_${string}`;
  child_generation_id: `gen_${string}`;
  surface: string;
  /** The parent's keyed event; its span becomes the delegation span's parent. */
  parent_keyed_event_id: `evt_${string}`;
  /** The later of the two keyed events, which completed the pair. */
  caused_by: `evt_${string}`[];
}

export type DelegationOutcomeV3 =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "denied"
  | "interrupted"
  | "unknown";

/** One completion to write for a key-linked delegation that has not completed. */
export interface DelegationCompletionPlanV3 {
  delegation_id: `del_${string}`;
  parent_generation_id: `gen_${string}`;
  child_generation_id: `gen_${string}`;
  started_event_id: `evt_${string}`;
  outcome: DelegationOutcomeV3;
  reason: "child_terminal" | "child_done_idle";
  cause_event_id: `evt_${string}`;
}

export interface DelegationPlanV3 {
  links: DelegationLinkPlanV3[];
  completions: DelegationCompletionPlanV3[];
}

type KeyedEvent = Extract<EventV3, { event_type: "agent.delegation_keyed" }>;
type StartedEvent = Extract<EventV3, { event_type: "agent.started" }>;

const OUTCOMES = new Set<string>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "denied",
  "interrupted",
  "unknown",
]);

function generationOf(event: EventV3): `gen_${string}` | undefined {
  return "generation_id" in event.scope
    ? (event.scope.generation_id as `gen_${string}`)
    : undefined;
}

function keyOf(event: KeyedEvent): string {
  const key = event.payload.delegation_key;
  // A key fingerprinted under another privacy epoch cannot be compared, so
  // the epoch is part of the join key: such a pair simply never links.
  return `${event.payload.surface}\0${key.key_epoch}\0${key.scope}\0${key.digest}`;
}

/**
 * Decide which key-linked delegations to record and which to complete (ADR
 * 0268). Pure: the caller supplies the ledger's events, in order, and the
 * coordination view projected from the same read.
 *
 * A link needs one parent generation and a child generation that recorded the
 * same key, in either order. A key recorded by two parents is ambiguous and
 * links nothing. A key seen on one side only links nothing. A child that
 * already has a native parent, a parent in its own instance, or a cycle,
 * links nothing. Time, names and task text play no part.
 */
export function planDelegationLinksV3(
  events: readonly EventV3[],
  view: Pick<CoordinationViewV3, "instances" | "terminal_generations">,
): DelegationPlanV3 {
  const order = new Map<string, number>();
  const instanceOf = new Map<string, string>();
  const nativeParent = new Map<string, string>();
  const parentsByKey = new Map<string, Map<string, KeyedEvent>>();
  const childrenByKey = new Map<string, Map<string, KeyedEvent>>();
  const linkedChild = new Map<string, StartedEvent>();
  const keyedParentOf = new Map<string, string>();
  const completed = new Set<string>();

  events.forEach((event, index) => {
    order.set(event.event_id, index);
    const generation = generationOf(event);
    if (event.event_type === "session.started" && generation) {
      instanceOf.set(generation, event.scope.instance_id);
      const parent = (event.links as { parent_generation_id?: string }).parent_generation_id;
      if (parent) nativeParent.set(generation, parent);
    } else if (event.event_type === "agent.delegation_keyed" && generation) {
      const index = event.payload.side === "parent" ? parentsByKey : childrenByKey;
      const key = keyOf(event);
      const sides = index.get(key) ?? new Map<string, KeyedEvent>();
      if (!sides.has(generation)) sides.set(generation, event);
      index.set(key, sides);
    } else if (event.event_type === "agent.started" && isDelegationLinkEventV3(event)) {
      if (generation && !linkedChild.has(event.payload.child_generation_id)) {
        linkedChild.set(event.payload.child_generation_id, event);
        keyedParentOf.set(event.payload.child_generation_id, generation);
      }
    } else if (event.event_type === "agent.completed") {
      completed.add(event.payload.delegation_id);
    }
  });

  const parentOf = (generation: string): string | undefined =>
    nativeParent.get(generation) ?? keyedParentOf.get(generation);
  const wouldCycle = (parent: string, child: string): boolean => {
    const seen = new Set([child]);
    let cursor: string | undefined = parent;
    while (cursor) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = parentOf(cursor);
    }
    return false;
  };

  const links: DelegationLinkPlanV3[] = [];
  for (const [key, children] of childrenByKey) {
    const parents = parentsByKey.get(key);
    if (!parents || parents.size !== 1) continue;
    const [parentGeneration, parentEvent] = [...parents][0]!;
    for (const [childGeneration, childEvent] of children) {
      if (childGeneration === parentGeneration) continue;
      if (nativeParent.has(childGeneration) || linkedChild.has(childGeneration)) continue;
      const parentInstance = instanceOf.get(parentGeneration);
      const childInstance = instanceOf.get(childGeneration);
      if (!parentInstance || !childInstance || parentInstance === childInstance) continue;
      if (wouldCycle(parentGeneration, childGeneration)) continue;
      const later =
        (order.get(parentEvent.event_id) ?? 0) > (order.get(childEvent.event_id) ?? 0)
          ? parentEvent
          : childEvent;
      links.push({
        parent_generation_id: parentGeneration as `gen_${string}`,
        child_generation_id: childGeneration as `gen_${string}`,
        surface: parentEvent.payload.surface,
        parent_keyed_event_id: parentEvent.event_id as `evt_${string}`,
        caused_by: [later.event_id as `evt_${string}`],
      });
      keyedParentOf.set(childGeneration, parentGeneration);
    }
  }

  const completions: DelegationCompletionPlanV3[] = [];
  for (const [childGeneration, started] of linkedChild) {
    if (completed.has(started.payload.delegation_id)) continue;
    const parentGeneration = generationOf(started);
    if (!parentGeneration) continue;
    const base = {
      delegation_id: started.payload.delegation_id as `del_${string}`,
      parent_generation_id: parentGeneration,
      child_generation_id: childGeneration as `gen_${string}`,
      started_event_id: started.event_id as `evt_${string}`,
    };
    const terminal = view.terminal_generations[childGeneration]?.terminal;
    if (terminal) {
      completions.push({
        ...base,
        outcome: (OUTCOMES.has(terminal.outcome)
          ? terminal.outcome
          : "unknown") as DelegationOutcomeV3,
        reason: "child_terminal",
        cause_event_id: terminal.event_id as `evt_${string}`,
      });
      continue;
    }
    const live = Object.values(view.instances).find(
      (candidate) => candidate.generation_id === childGeneration,
    );
    if (live && live.lifecycle_state === "done" && live.activity === "idle") {
      completions.push({
        ...base,
        outcome: "succeeded",
        reason: "child_done_idle",
        cause_event_id: live.last_event_id as `evt_${string}`,
      });
    }
  }
  return { links, completions };
}
