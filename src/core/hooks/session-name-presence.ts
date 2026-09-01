/**
 * Session-name presence for `turn.completed`.
 *
 * While the current V3 coordination row carries a `suggested_session_name`, report whether the
 * naming ritual is satisfied: either the immediate post-mint assistant text
 * showed the exact block, or an earlier PreToolUse already stamped it. The
 * transcript callback must enforce ordering and block shape; a late final
 * answer or a tool result must not count.
 *
 * Two properties the stop-hook naming rule depends on:
 *
 * 1. Once a name is satisfied, every later stop keeps reporting `true` rather
 *    than omitting the field. The rule wants an in-window `turn.completed` carrying
 *    `session_name_present: true`; omitting it after the coordination stamp meant
 *    nothing could ever re-emit the flag, so every subsequent reply blocked --
 *    including the replies reproducing the exact name the rule asked for.
 * 2. The result names WHICH suggested name it covered, so a projector rebuild
 *    attributes the sighting to that name instead of to whichever name is
 *    current during the replay. Without it, a re-minted name inherited an older
 *    name's sighting and looked satisfied without ever having been shown.
 *
 * Never throws: coordination telemetry must not take down a hook.
 */

import { sessionNameDisplayAcceptedNames } from "../agents/session-name-display.ts";
import { stampSessionNameSeen } from "../agents/state/heartbeat-writer.ts";
import { readLiveCoordinationRow } from "../agents/state/live-coordination-view.ts";

export interface SessionNamePresence {
  session_name_present?: boolean;
  session_name_present_for?: string;
}

export function sessionNamePresence(
  coordRoot: string,
  instanceId: string,
  scanAssistantText: (name: string) => boolean,
): SessionNamePresence {
  try {
    const row = readLiveCoordinationRow(coordRoot, instanceId);
    const name = row?.suggested_session_name;
    if (!name) return {};
    if (row?.session_name_seen_for === name) {
      return { session_name_present: true, session_name_present_for: name };
    }
    // A display of the title Harnery last asked for counts here too, so Stop
    // and the PreToolUse gate cannot disagree about the same reply.
    const present = sessionNameDisplayAcceptedNames(row).some((candidate) =>
      scanAssistantText(candidate),
    );
    if (present) stampSessionNameSeen(coordRoot, instanceId, name);
    return { session_name_present: present, session_name_present_for: name };
  } catch {
    return {};
  }
}
