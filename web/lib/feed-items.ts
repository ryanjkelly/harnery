/**
 * Pure helpers over feed items, safe to import from client components (the
 * reader in `feed-reader.ts` pulls in fs and git).
 */

import type { FeedAgentRef, FeedItem } from "../../src/core/feed/index";

export type { FeedAgentRef, FeedItem };

/** Every machine label an item mentions. */
export function feedItemMachines(item: FeedItem): string[] {
  return item.kind === "message" ? [item.from.machine, item.to.machine] : [item.agent.machine];
}

/** Every agent name an item mentions. */
export function feedItemAgents(item: FeedItem): string[] {
  return item.kind === "message" ? [item.from.name, item.to.name] : [item.agent.name];
}
