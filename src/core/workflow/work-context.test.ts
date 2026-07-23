import { describe, expect, test } from "bun:test";
import {
  freezeWorkflowWorkContext,
  isCanonicalWorkflowWorkContext,
  normalizeWorkflowWorkContext,
} from "./work-context.ts";

describe("workflow work context", () => {
  test("normalizes the bounded public shape and freezes nested acceptance", () => {
    const context = freezeWorkflowWorkContext({
      schema_version: 1,
      id: "work-1",
      title: "  Implement  ",
      objective: "  Complete the assignment  ",
      acceptance: ["  Tests pass  "],
    });
    expect(context).toEqual({
      schema_version: 1,
      id: "work-1",
      title: "Implement",
      objective: "Complete the assignment",
      acceptance: ["Tests pass"],
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.acceptance)).toBe(true);
    expect(isCanonicalWorkflowWorkContext(context)).toBe(true);
  });

  test("rejects unknown fields, invalid ids, unsupported schemas, and excessive criteria", () => {
    const valid = {
      schema_version: 1,
      id: "work-1",
      title: "Implement",
      objective: "Complete the assignment",
      acceptance: [],
    };
    expect(() => normalizeWorkflowWorkContext({ ...valid, secret: "no" })).toThrow(
      /unknown field "secret"/,
    );
    expect(() => normalizeWorkflowWorkContext({ ...valid, id: "../escape" })).toThrow(
      /invalid workflow work context id/,
    );
    expect(() => normalizeWorkflowWorkContext({ ...valid, schema_version: 2 })).toThrow(
      /unsupported schema/,
    );
    expect(() =>
      normalizeWorkflowWorkContext({
        ...valid,
        acceptance: Array.from({ length: 51 }, () => "criterion"),
      }),
    ).toThrow(/at most 50 criteria/);
  });
});
