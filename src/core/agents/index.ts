/**
 * agent-coord library public exports.
 *
 * `coord-client`: coordination helpers
 * (Heartbeat reader, owner-resolver via ppid-walk, monorepo-root finder).
 * Imported by every TS caller that needs to read coord state.
 *
 * `canonical-emit`: fire-and-forget client for the canonical event stream;
 * spawns `bin/agent-coord emit-event` and never blocks the caller.
 */

export * from "./canonical-emit.js";
export * from "./coord-client.js";
export * from "./session-events.js";
