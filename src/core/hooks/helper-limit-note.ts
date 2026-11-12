/**
 * The session-start line that tells an agent the person has limited helper
 * agents. Pure: the caller resolves the limit, the skip switch and the bin
 * name, so this module only decides whether a line is due and words it.
 */
import { formatHelperLimit, type HelperLimit, isNoHelperLimit } from "../helper-limit.ts";

export interface HelperLimitNoteInput {
  /** Adapter the session runs under. Only `claude-code` enforces a limit today. */
  adapter: string;
  /** The limit in effect, or null when helpers are unlimited. */
  limit: HelperLimit | null;
  /** True when `HARNERY_HELPER_LIMIT_SKIP=1` turns enforcement off. */
  skipped: boolean;
  /** Host bin name for the command the line points at. */
  bin: string;
}

/** The line to add to the session-start context, or "" when none is due. */
export function buildHelperLimitNote(input: HelperLimitNoteInput): string {
  if (input.adapter !== "claude-code") return "";
  if (input.skipped || !input.limit || isNoHelperLimit(input.limit)) return "";
  return (
    `Helper limit: the person has limited helper agents (subagents) to ${formatHelperLimit(input.limit)} or cheaper. ` +
    "Start helpers at that level or lower; Harnery lowers a helper above it where it can. " +
    "If the person asks for a stronger helper, tell them the limit applies. " +
    `\`${input.bin} devtools helpers\` changes it.`
  );
}
