/**
 * A client title's description is written when the thread starts and gains
 * `[DONE] ` when it is marked done, and its wording changes at no other time
 * (ADR 0086, made enforceable for writing surfaces by ADR 0247). Titles minted
 * mid-session describe one turn of work and are too narrow to name the whole
 * session.
 *
 * `appliedFor` is the title a writing surface already confirmed on the client.
 * Once it exists, Harnery may ask for or confirm only two further titles: the
 * same title with a different agent name, and the terminal `[DONE] ` form
 * (ADR 0269).
 */
export const DONE_TITLE_PREFIX = "[DONE] ";

export function titleChangeAllowed(appliedFor: string | undefined, pending: string): boolean {
  if (!pending) return false;
  if (!appliedFor) return true;
  if (pending === appliedFor) return true;
  if (isAgentNameChange(appliedFor, pending)) return true;
  return pending.startsWith(DONE_TITLE_PREFIX) && !appliedFor.startsWith(DONE_TITLE_PREFIX);
}

/** The parts of a Harnery title: `[DONE] Agent <name> - <description>`. */
export interface AgentTitleParts {
  done: boolean;
  agentName: string;
  description: string;
}

const AGENT_TITLE = /^(\[DONE\] )?Agent (.+?) - (.+)$/;

/** Split a title in Harnery's form, or null for any other wording. */
export function parseAgentTitle(title: string | undefined): AgentTitleParts | null {
  const match = title ? AGENT_TITLE.exec(title) : null;
  if (!match) return null;
  return { done: Boolean(match[1]), agentName: match[2] ?? "", description: match[3] ?? "" };
}

/**
 * `title` with its agent name replaced, every other character kept. Null when
 * the title is not in Harnery's form or already carries that name.
 */
export function withAgentName(title: string | undefined, agentName: string): string | null {
  const parts = parseAgentTitle(title);
  const name = agentName.trim();
  if (!parts || !name || parts.agentName === name) return null;
  return `${parts.done ? DONE_TITLE_PREFIX : ""}Agent ${name} - ${parts.description}`;
}

/**
 * True when `pending` is `appliedFor` with only the agent name changed. The
 * name in a title follows the agent that holds the thread: a second session
 * in the thread has a new name, and an `Agent unknown - ...` title gains the
 * real name once identity resolves (ADR 0269). The description and the done
 * marker must match, so this never lets a new task retitle the thread.
 */
export function isAgentNameChange(appliedFor: string | undefined, pending: string): boolean {
  const applied = parseAgentTitle(appliedFor);
  const next = parseAgentTitle(pending);
  if (!applied || !next) return false;
  return (
    applied.done === next.done &&
    applied.description === next.description &&
    applied.agentName !== next.agentName
  );
}

/**
 * The command note for a session that starts in a client thread an earlier
 * session already titled, when that title needs no change (ADR 0269).
 */
export const KEPT_THREAD_TITLE_NOTE =
  "This thread already has a title from an earlier session. Leave the thread title unchanged; do not rename or regenerate it.";
