/**
 * Session-name presence for `turn.stop`.
 *
 * While the heartbeat carries a `suggested_session_name`, report whether the
 * naming ritual is satisfied: either this turn's reply shows the name, or an
 * earlier reply already did. Scanning covers assistant text blocks only (the
 * raw transcript tail also carries the name inside the set-task tool_result,
 * which must not count) plus the adapter-supplied last assistant message, for
 * stops that arrive without a transcript.
 *
 * Two properties the stop-hook naming rule depends on:
 *
 * 1. Once a name is satisfied, every later stop keeps reporting `true` rather
 *    than omitting the field. The rule wants an in-window `turn.stop` carrying
 *    `session_name_present: true`; omitting it after the heartbeat stamp meant
 *    nothing could ever re-emit the flag, so every subsequent reply blocked --
 *    including the replies reproducing the exact name the rule asked for.
 * 2. The result names WHICH suggested name it covered, so a projector rebuild
 *    attributes the sighting to that name instead of to whichever name is
 *    current during the replay. Without it, a re-minted name inherited an older
 *    name's sighting and looked satisfied without ever having been shown.
 *
 * Never throws: coordination telemetry must not take down a hook.
 */

import { readHeartbeat, stampSessionNameSeen } from "../agents/state/heartbeat-writer.ts";

export interface SessionNamePresence {
  session_name_present?: boolean;
  session_name_present_for?: string;
}

export function sessionNamePresence(
  coordRoot: string,
  instanceId: string,
  lastAssistantMessage: string,
  scanAssistantText: (name: string) => boolean,
): SessionNamePresence {
  try {
    const hb = readHeartbeat(coordRoot, instanceId);
    const name = hb?.suggested_session_name;
    if (!name) return {};
    if (hb?.session_name_seen_for === name) {
      return { session_name_present: true, session_name_present_for: name };
    }
    const present = scanAssistantText(name) || lastAssistantMessage.includes(name);
    if (present) stampSessionNameSeen(coordRoot, instanceId, name);
    return { session_name_present: present, session_name_present_for: name };
  } catch {
    return {};
  }
}
