/**
 * agent-coord library public exports.
 *
 * `coord-client`: V2 producer identity resolution, ppid-map attribution, and
 * coordination-root discovery.
 *
 * `canonical-emit`: canonical V2 observation helpers.
 */

export * from "./canonical-emit.js";
export * from "./coord-client.js";
export * from "./live-observation-v3.js";
export * from "./session-events.js";
export * from "./state/session-state.js";
