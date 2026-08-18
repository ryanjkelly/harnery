import { describe, expect, test } from "bun:test";
import { type TProperties, Type } from "@sinclair/typebox";
import { validateAdditiveSchemaAdvanceV3 } from "./advance.ts";

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
});
