import type { EventAdapterIdV3 } from "../../../events/v3/adapter-id.ts";
import { claudeCodeBehavior } from "./claude-code.ts";
import { codexBehavior } from "./codex.ts";
import { cursorBehavior } from "./cursor.ts";
import { openclawBehavior } from "./openclaw.ts";
import { opencodeBehavior } from "./opencode.ts";
import type { AdapterBehavior } from "./types.ts";

export type {
  AdapterBehavior,
  CrossShellInput,
  EffortAttestationSource,
  PromptContextNudges,
} from "./types.ts";

/**
 * One behavior per adapter id. The `Record` type makes a new adapter id a
 * compile error here until its module exists.
 */
export const ADAPTER_BEHAVIORS: Record<EventAdapterIdV3, AdapterBehavior> = {
  "claude-code": claudeCodeBehavior,
  cursor: cursorBehavior,
  codex: codexBehavior,
  opencode: opencodeBehavior,
  openclaw: openclawBehavior,
};

/** The single lookup the hook CLI and the V3 producer use instead of branching. */
export function adapterBehavior(adapter: EventAdapterIdV3): AdapterBehavior {
  return ADAPTER_BEHAVIORS[adapter];
}
