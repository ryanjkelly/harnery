/**
 * A client title is written when the session starts and when it is marked
 * done, and at no other time (ADR 0086, made enforceable for writing surfaces
 * by ADR 0247). Titles minted mid-session describe one turn of work and are
 * too narrow to name the whole session.
 *
 * `appliedFor` is the title a writing surface already confirmed on the client.
 * Once it exists, the only further title Harnery may ask for or confirm is the
 * terminal `[DONE] ` form. A stored name corrected after the title was applied
 * (an `Agent unknown - ...` name fixed once identity resolves) is therefore
 * not pushed to the open thread; the corrected name is used at done.
 */
export const DONE_TITLE_PREFIX = "[DONE] ";

export function titleChangeAllowed(appliedFor: string | undefined, pending: string): boolean {
  if (!pending) return false;
  if (!appliedFor) return true;
  if (pending === appliedFor) return true;
  return pending.startsWith(DONE_TITLE_PREFIX) && !appliedFor.startsWith(DONE_TITLE_PREFIX);
}
