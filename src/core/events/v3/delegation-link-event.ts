/**
 * Provenance `source_event` of the `agent.started` and `agent.completed`
 * events that link a client-delegated worker to its parent (ADR 0268). Readers
 * use it to tell a key-linked delegation from a native subagent.
 *
 * This file imports nothing so that readers copied into another package can
 * take it without the coordination view.
 */
export const DELEGATION_LINK_SOURCE_EVENT = "agent-coord.delegation-link";

export function isDelegationLinkEventV3(event: {
  provenance?: { source_event?: string };
}): boolean {
  return event.provenance?.source_event === DELEGATION_LINK_SOURCE_EVENT;
}
