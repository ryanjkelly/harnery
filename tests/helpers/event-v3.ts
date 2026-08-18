import type { TObject, TSchema } from "@sinclair/typebox";
import { canonicalJsonV2 } from "../../src/core/events/v2/canonical.ts";
import { EventV3Schema } from "../../src/core/events/v3/contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../../src/core/events/v3/generated.ts";
import type { LedgerFrameV3 } from "../../src/core/events/v3/reader.ts";

export type EventV3Fixture = Record<string, unknown>;

type SchemaNode = EventV3Fixture & {
  const?: unknown;
  anyOf?: TSchema[];
  type?: string;
  properties?: Record<string, TSchema>;
  required?: string[];
  items?: TSchema;
  minItems?: number;
  pattern?: string;
  minimum?: number;
};

export function eventV3Fixture(eventType: string, sequence: number): EventV3Fixture {
  const branches = (EventV3Schema as unknown as { anyOf: TObject[] }).anyOf;
  const branch = branches.find(({ properties }) => properties.event_type.const === eventType);
  if (!branch) throw new Error(`missing V3 event branch: ${eventType}`);
  const event = fixtureObject(sample(branch));
  const id = `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
  event.event_id = `evt_${id}`;
  fixtureObject(event.contract).schema_digest = EVENT_V3_SCHEMA_DIGEST;
  fixtureObject(event.producer).sequence = sequence;
  fixtureObject(event.links).caused_by = [];
  if (eventType === "ledger.genesis") {
    const payload = fixtureObject(event.payload);
    payload.genesis_id = "gex_00000000-0000-7000-8000-000000000001";
    payload.contract_digest = `sha256:${"c".repeat(64)}`;
    payload.generated_schema_digest = EVENT_V3_SCHEMA_DIGEST;
  }
  if (eventType === "ledger.activated") {
    fixtureObject(event.payload).eligible_after_event_id = event.event_id;
  }
  return event;
}

export function eventV3Frame(
  event: EventV3Fixture,
  segmentOrdinal: number,
  byteOffset: number,
): LedgerFrameV3 {
  return {
    raw: canonicalJsonV2(event),
    position: { segment_ordinal: segmentOrdinal, byte_offset: byteOffset },
  };
}

export function fixtureObject(value: unknown): EventV3Fixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected fixture object, got ${canonicalJsonV2(value)}`);
  }
  return value as EventV3Fixture;
}

function sample(schema: TSchema): unknown {
  const node = schema as SchemaNode;
  if (node.const !== undefined) return node.const;
  if (Array.isArray(node.anyOf)) return sample(node.anyOf[0]);
  if (node.type === "object") {
    if (!node.properties) throw new Error("object fixture schema has no properties");
    const result: EventV3Fixture = {};
    for (const property of node.required ?? [])
      result[property] = sample(node.properties[property]);
    return result;
  }
  if (node.type === "array") {
    if (!node.items) throw new Error("array fixture schema has no items");
    const items = node.items;
    return Array.from({ length: node.minItems ?? 0 }, () => sample(items));
  }
  if (node.type === "string") return sampleString(node.pattern);
  if (node.type === "integer" || node.type === "number") return node.minimum ?? 0;
  if (node.type === "boolean") return false;
  throw new Error(`unsupported fixture schema: ${canonicalJsonV2(node)}`);
}

function sampleString(pattern?: string): string {
  if (!pattern) return "fixture";
  if (pattern.includes("\\d{4}-\\d{2}")) return "2026-08-18T14:00:00.000Z";
  if (pattern.startsWith("^sha256:")) return `sha256:${"a".repeat(64)}`;
  if (pattern.startsWith("^cap_")) return `cap_${"a".repeat(64)}`;
  if (pattern.startsWith("^(sid|tid|hid)_")) return `sid_${"a".repeat(64)}`;
  for (const prefix of ["evt", "gen", "att", "clk", "span", "del"]) {
    if (pattern.startsWith(`^${prefix}_`)) {
      return `${prefix}_00000000-0000-7000-8000-000000000001`;
    }
  }
  for (const prefix of ["txn", "gex", "act"]) {
    if (pattern.startsWith(`^${prefix}_`)) {
      return `${prefix}_00000000-0000-7000-8000-000000000001`;
    }
  }
  for (const prefix of ["root", "inst", "pep", "prd", "boot", "build", "run", "wf", "art"]) {
    if (pattern.startsWith(`^${prefix}_`)) return `${prefix}_fixture`;
  }
  if (pattern.includes("/[a-z0-9.+-]+")) return "text/plain";
  if (pattern.startsWith("^[0-9]+")) return "0";
  if (pattern.startsWith("^(?!.*")) return "fixture.txt";
  return "fixture";
}
