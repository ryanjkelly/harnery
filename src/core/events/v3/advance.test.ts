import { describe, expect, test } from "bun:test";
import { type TObject, type TProperties, type TSchema, Type } from "@sinclair/typebox";
import { validateAdditiveSchemaAdvanceV3 } from "./advance.ts";
import { EventV3Schema } from "./contract.ts";

const strict = (properties: TProperties) =>
  Type.Object(properties, { additionalProperties: false });

describe("event ledger V3 additive schema advances", () => {
  test("accepts a new optional field", () => {
    const prior = strict({ id: Type.String() });
    const next = strict({ id: Type.String(), note: Type.Optional(Type.String()) });
    expect(validateAdditiveSchemaAdvanceV3(prior, next)).toEqual({
      eligible: true,
      strict: true,
      issues: [],
    });
  });

  test("accepts a new event-union branch", () => {
    const prior = Type.Union([
      strict({ type: Type.Literal("one") }),
      strict({ type: Type.Literal("two") }),
    ]);
    const next = Type.Union([
      strict({ type: Type.Literal("one") }),
      strict({ type: Type.Literal("two") }),
      strict({ type: Type.Literal("three") }),
    ]);
    expect(validateAdditiveSchemaAdvanceV3(prior, next).eligible).toBe(true);
  });

  test("rejects removals, required additions, and constraint changes", () => {
    const prior = strict({ id: Type.String(), count: Type.Integer({ minimum: 0 }) });
    const removed = strict({ id: Type.String() });
    const required = strict({
      id: Type.String(),
      count: Type.Integer({ minimum: 0 }),
      note: Type.String(),
    });
    const narrowed = strict({ id: Type.String(), count: Type.Integer({ minimum: 1 }) });

    expect(validateAdditiveSchemaAdvanceV3(prior, removed).eligible).toBe(false);
    expect(validateAdditiveSchemaAdvanceV3(prior, required).eligible).toBe(false);
    expect(validateAdditiveSchemaAdvanceV3(prior, narrowed).eligible).toBe(false);
  });

  test("rejects an identical schema because an advance must be strict", () => {
    const schema = strict({ id: Type.String() });
    expect(validateAdditiveSchemaAdvanceV3(schema, schema)).toEqual({
      eligible: false,
      strict: false,
      issues: [],
    });
  });

  test("accepts an optional field added inside the complete V3 event union", () => {
    const next = structuredClone(EventV3Schema) as TSchema;
    const payload = eventBranch(next, "health.capability_drift").properties.payload as TObject;
    payload.properties.fixture_note = Type.String();

    expect(validateAdditiveSchemaAdvanceV3(EventV3Schema, next)).toEqual({
      eligible: true,
      strict: true,
      issues: [],
    });
  });

  test("classifies the slowest-hook duration as an additive in-place advance", () => {
    const prior = structuredClone(EventV3Schema) as TSchema;
    const payload = eventBranch(prior, "turn.completed").properties.payload as TObject;
    const harness = payload.properties.harness as unknown as { anyOf: TObject[] };
    const observed = harness.anyOf.find(({ properties }) => properties.state.const === "observed");
    if (!observed) throw new Error("turn harness observation has no observed branch");
    const value = observed.properties.value as TObject;
    delete value.properties.slowest_hook_ms;

    expect(validateAdditiveSchemaAdvanceV3(prior, EventV3Schema)).toEqual({
      eligible: true,
      strict: true,
      issues: [],
    });
  });

  test("accepts a new complete event branch and rejects branch removal or rename", () => {
    const added = structuredClone(EventV3Schema) as TSchema;
    const addedBranches = (added as unknown as { anyOf: TObject[] }).anyOf;
    const newBranch = structuredClone(eventBranch(added, "health.capability_drift"));
    newBranch.properties.event_type = Type.Literal("health.fixture_signal");
    addedBranches.push(newBranch);
    expect(validateAdditiveSchemaAdvanceV3(EventV3Schema, added).eligible).toBe(true);

    const removed = structuredClone(EventV3Schema) as TSchema;
    const removedBranches = (removed as unknown as { anyOf: TObject[] }).anyOf;
    removedBranches.splice(
      removedBranches.findIndex(
        ({ properties }) => properties.event_type.const === "health.capability_drift",
      ),
      1,
    );
    expect(validateAdditiveSchemaAdvanceV3(EventV3Schema, removed).eligible).toBe(false);

    const renamed = structuredClone(EventV3Schema) as TSchema;
    eventBranch(renamed, "health.capability_drift").properties.event_type =
      Type.Literal("health.renamed");
    expect(validateAdditiveSchemaAdvanceV3(EventV3Schema, renamed).eligible).toBe(false);
  });
});

function eventBranch(schema: TSchema, eventType: string): TObject {
  const branches = (schema as unknown as { anyOf: TObject[] }).anyOf;
  const branch = branches.find(({ properties }) => properties.event_type.const === eventType);
  if (!branch) throw new Error(`missing V3 event branch: ${eventType}`);
  return branch;
}
