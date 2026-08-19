import { describe, expect, test } from "bun:test";
import { type TObject, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { canonicalJsonV3 } from "./canonical.ts";
import { EVENT_V3_CORE_EVENT_TYPES, EventV3Schema, ObservationV3Schema } from "./contract.ts";
import { validateEventV3 } from "./validate.ts";

const uuid = "00000000-0000-7000-8000-000000000001";
const secondUuid = "00000000-0000-7000-8000-000000000002";

describe("event ledger V3 conformance fixtures", () => {
  test("validates one relationally sound fixture for every event type", () => {
    const fixtures = eventBranches().map((branch) => relationalFixture(object(sample(branch))));
    const fixtureTypes = fixtures.map((fixture) => fixture.event_type as string).sort();

    expect(fixtureTypes).toEqual([...EVENT_V3_CORE_EVENT_TYPES].sort());
    for (const fixture of fixtures) {
      const result = validateEventV3(fixture);
      expect(result.issues, `${fixture.event_type}: ${result.issues.join(", ")}`).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  test("covers every Observation state", () => {
    const observation = ObservationV3Schema(Type.Integer({ minimum: 0 }));
    const fixtures = [
      { state: "observed", value: 0, attestation: "native", confidence: "exact" },
      { state: "unsupported", capability: "fixture" },
      { state: "expected_but_missing", capability: "fixture", reason: "not_observed" },
      { state: "redacted", reason: "policy" },
      { state: "unknown", reason: "not_observed" },
      { state: "not_applicable" },
    ];

    expect(fixtures.map((fixture) => fixture.state)).toEqual([
      "observed",
      "unsupported",
      "expected_but_missing",
      "redacted",
      "unknown",
      "not_applicable",
    ]);
    for (const fixture of fixtures) expect(Value.Check(observation, fixture)).toBe(true);
  });

  test("accepts recovered terminal shapes only with bound unknown timing", () => {
    for (const [eventType, reason] of [
      ["tool.completed", "completion_not_observed_before_turn_end"],
      ["command.completed", "command_completion_not_observed"],
    ] as const) {
      const event = fixtureFor(eventType);
      const provenance = object(event.provenance);
      const payload = object(event.payload);
      const span = object(payload.span);
      const unknownDuration = { state: "unknown", reason };
      provenance.attestation = "derived";
      payload.outcome = "unknown";
      payload.recovery = { reason };
      payload.duration_ms = unknownDuration;
      span.duration_ms = structuredClone(unknownDuration);
      delete payload.exit_code;

      expect(validateEventV3(event).issues).toEqual([]);
      expect(canonicalJsonV3(payload.duration_ms)).toBe(canonicalJsonV3(span.duration_ms));

      const observed = structuredClone(event);
      const observedPayload = object(observed.payload);
      const observedSpan = object(observedPayload.span);
      observedPayload.duration_ms = {
        state: "observed",
        value: 0,
        attestation: "derived",
        confidence: "exact",
      };
      observedSpan.duration_ms = structuredClone(observedPayload.duration_ms);
      expect(validateEventV3(observed).issues).toContain(
        "/payload/duration_ms:recovery_requires_unknown_duration",
      );
    }
  });

  test("rejects span identity, causal, duration, and clock-regression contradictions", () => {
    const baseline = fixtureFor("tool.completed");

    const mismatchedLink = structuredClone(baseline);
    object(mismatchedLink.links).span_id = `span_${secondUuid}`;
    expect(validateEventV3(mismatchedLink).issues).toContain(
      "/payload/span/span_id:must_match_links",
    );

    const missingCause = structuredClone(baseline);
    object(object(missingCause.payload).span).open_event_id = `evt_${secondUuid}`;
    expect(validateEventV3(missingCause).issues).toContain(
      "/payload/span/open_event_id:must_be_causal_parent",
    );

    const mismatchedDuration = structuredClone(baseline);
    object(object(mismatchedDuration.payload).duration_ms).value = 7;
    expect(validateEventV3(mismatchedDuration).issues).toContain(
      "/payload/duration_ms:must_match_span_duration",
    );

    const regressed = structuredClone(baseline);
    object(object(regressed.payload).span).opened_at = "2026-08-18T14:00:01.000Z";
    expect(validateEventV3(regressed).issues).toContain(
      "/payload/span/duration_ms:clock_regression_must_be_missing",
    );
  });

  test("accepts bounded slowest-hook timing and rejects contradictory durations", () => {
    const baseline = fixtureFor("turn.completed");
    const harness = object(object(object(baseline.payload).harness).value);
    harness.hook_time_ms = 25_816;
    harness.hook_count = 17;
    harness.slowest_hook = "pre-tool-use";
    harness.slowest_hook_ms = 4_113;
    expect(validateEventV3(baseline).issues).toEqual([]);

    const tooLarge = structuredClone(baseline);
    object(object(object(tooLarge.payload).harness).value).slowest_hook_ms = 25_817;
    expect(validateEventV3(tooLarge).issues).toContain(
      "/payload/harness/value/slowest_hook_ms:must_not_exceed_hook_time",
    );

    const unnamed = structuredClone(baseline);
    delete object(object(object(unnamed.payload).harness).value).slowest_hook;
    expect(validateEventV3(unnamed).issues).toContain(
      "/payload/harness/value/slowest_hook:required_with_duration",
    );
  });
});

type Fixture = Record<string, unknown>;
type SchemaNode = Fixture & {
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

function eventBranches(): TObject[] {
  return (EventV3Schema as unknown as { anyOf: TObject[] }).anyOf;
}

function fixtureFor(eventType: string): Fixture {
  const branch = eventBranches().find(
    ({ properties }) => properties.event_type.const === eventType,
  );
  if (!branch) throw new Error(`missing V3 event branch: ${eventType}`);
  return relationalFixture(object(sample(branch)));
}

function relationalFixture(fixture: Fixture): Fixture {
  const payload = object(fixture.payload);
  const scope = object(fixture.scope);
  const links = object(fixture.links);
  const provenance = object(fixture.provenance);
  if (fixture.event_type === "ledger.activated") {
    payload.eligible_after_event_id = fixture.event_id;
  }
  if (
    fixture.event_type === "session.started" ||
    fixture.event_type === "session.attestation_changed"
  ) {
    const runtimeAttestation = object(payload.runtime_attestation);
    runtimeAttestation.attestation_id = fixture.attestation_id;
    runtimeAttestation.generation_id = scope.generation_id;
    runtimeAttestation.declared_by_event_id = fixture.event_id;
  }
  if (fixture.event_type === "session.attestation_changed") {
    payload.prior_attestation_id = `att_${secondUuid}`;
  }
  if (fixture.event_type === "session.termination_observed") {
    payload.observer_instance_id = "inst_observer";
    payload.subject_instance_id = "inst_subject";
  }
  if (fixture.event_type === "progress.observed") {
    payload.evidence_event_ids = [`evt_${secondUuid}`];
  }
  if (
    fixture.event_type === "coord.task_changed" ||
    fixture.event_type === "coord.lifecycle_changed" ||
    fixture.event_type === "coord.identity_attested"
  ) {
    object(payload.authority).transaction_id = `txn_${uuid}`;
  }
  if (fixture.event_type === "decision.state_changed") {
    object(payload.authority).record_id = "fixture";
  }
  if (fixture.event_type === "coord.claim_changed") {
    object(payload.target).access = payload.access;
    if (payload.operation !== "denied") {
      object(payload.authority).transaction_id = `txn_${uuid}`;
    }
  }
  if (payload.span) {
    const span = object(payload.span);
    links.span_id = span.span_id;
    if (span.parent_span_id) {
      links.parent_span_id = span.parent_span_id;
    }
  }
  if (links.span_id === links.parent_span_id) {
    links.parent_span_id = `span_${secondUuid}`;
  }
  if (provenance.attestation === "derived") provenance.attestation = "native";
  return fixture;
}

function sample(schema: TSchema): unknown {
  const node = schema as SchemaNode;
  if (node.const !== undefined) return node.const;
  if (Array.isArray(node.anyOf)) return sample(node.anyOf[0]);
  if (node.type === "object") {
    const result: Fixture = {};
    if (!node.properties) throw new Error("object fixture schema has no properties");
    for (const property of node.required ?? []) {
      result[property] = sample(node.properties[property]);
    }
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
  throw new Error(`unsupported fixture schema: ${canonicalJsonV3(node)}`);
}

function object(value: unknown): Fixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected fixture object, got ${canonicalJsonV3(value)}`);
  }
  return value as Fixture;
}

function sampleString(pattern?: string): string {
  if (!pattern) return "fixture";
  if (pattern.includes("\\d{4}-\\d{2}")) return "2026-08-18T14:00:00.000Z";
  if (pattern.startsWith("^sha256:")) return `sha256:${"a".repeat(64)}`;
  if (pattern.startsWith("^cap_")) return `cap_${"a".repeat(64)}`;
  if (pattern.startsWith("^(sid|tid|hid)_")) return `sid_${"a".repeat(64)}`;
  for (const prefix of ["evt", "gen", "att", "clk", "span", "del"]) {
    if (pattern.startsWith(`^${prefix}_`)) return `${prefix}_${uuid}`;
  }
  for (const prefix of ["txn", "gex", "act"]) {
    if (pattern.startsWith(`^${prefix}_`)) return `${prefix}_${uuid}`;
  }
  for (const prefix of ["root", "inst", "pep", "prd", "boot", "build", "run", "wf", "art"]) {
    if (pattern.startsWith(`^${prefix}_`)) return `${prefix}_fixture`;
  }
  if (pattern.includes("/[a-z0-9.+-]+")) return "text/plain";
  if (pattern.startsWith("^[0-9]+")) return "0";
  if (pattern.startsWith("^(?!.*")) return "fixture.txt";
  return "fixture";
}
