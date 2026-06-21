/**
 * CLI-side canonical event emission helper. Importable from any CLI surface
 * to emit-then-project in one call.
 *
 * Pattern: every state-changing CLI command appends its event first, then
 * runs the projector synchronously for the affected owner.
 */

import { type EmitInput, type Envelope, emit } from "./events/emit.ts";
import { findCoordRoot } from "./paths.ts";
import { projectHeartbeats } from "./state/heartbeat-projector.ts";

export interface EmitAndProjectResult {
  envelope: Envelope;
  projected: boolean;
}

/**
 * Emit a canonical event AND synchronously project it into the owner's v2
 * heartbeat. Idempotent on event_id: replays don't double-apply.
 *
 * Returns the emitted envelope so callers can inspect / log.
 *
 * Soft-fails on any internal error: never throws into the caller, because
 * this runs inside operator-facing CLI commands and a corrupt events.ndjson
 * line shouldn't break `agents set-task`.
 */
export function emitAndProject(
  input: EmitInput,
  opts: { coordRoot?: string; skipProject?: boolean } = {},
): EmitAndProjectResult | null {
  const root = opts.coordRoot ?? findCoordRoot();
  if (!root) return null;
  try {
    const envelope = emit(root, input);
    let projected = false;
    if (!opts.skipProject) {
      try {
        projectHeartbeats(root, [
          {
            schema_version: envelope.schema_version,
            event_id: envelope.event_id,
            event_type: envelope.event_type,
            ts: envelope.ts,
            instance_id: envelope.instance_id,
            session_id: envelope.session_id,
            parent_session_id: envelope.parent_session_id,
            turn_id: envelope.turn_id,
            parent_turn_id: envelope.parent_turn_id,
            harness: envelope.harness,
            source: envelope.source,
            data: envelope.data,
          },
        ]);
        projected = true;
      } catch {
        /* projector failure is non-fatal; next agent-coord project run catches up */
      }
    }
    return { envelope, projected };
  } catch {
    return null;
  }
}
