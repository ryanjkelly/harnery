/**
 * Names of agents currently live on other machines, for name assignment to
 * skip. Kept apart from `names.ts` because it reads cross-machine presence,
 * whose transports can start processes, while `names.ts` is loaded by
 * read-only consumers that must not reach them.
 */

import { readRemoteMachines } from "../../presence/index.ts";

/** Best effort: an unreadable presence view yields no names, never a throw. */
export function remoteLiveNames(coordRoot: string): string[] {
  try {
    const names: string[] = [];
    for (const { agents } of readRemoteMachines(coordRoot)) {
      for (const agent of agents) {
        if (agent.name) names.push(agent.name);
      }
    }
    return names;
  } catch {
    return [];
  }
}
