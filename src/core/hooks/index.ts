/**
 * agent-hooks library exports.
 *
 * Phase 1 (skeleton): exposes only the canonical event schema types. Parsers,
 * resolvers, and emit helpers ship in Phase 2.
 */

export {
  type Event,
  type EventEnvelope,
  type EventType,
  type Harness,
  type RedactionMarker,
  SCHEMA_VERSION,
  type Source,
} from "./events/schema.ts";
