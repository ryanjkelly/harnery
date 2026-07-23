import { describe, expect, test } from "bun:test";
import {
  freezeWorkflowAttemptContext,
  isCanonicalWorkflowAttemptContext,
  normalizeWorkflowAttemptContext,
} from "./attempt-context.ts";

describe("workflow attempt context", () => {
  test("normalizes and deeply freezes a bounded retry synopsis", () => {
    const context = freezeWorkflowAttemptContext({
      schema_version: 1,
      number: 2,
      trigger: "retry",
      prior: {
        run_id: "wf-prior",
        causes: ["workflow_error", "acceptance_unknown"],
        error: "  command failed  ",
        acceptance: { satisfied: 1, unsatisfied: 0, unknown: 1, total: 2 },
        unresolved: [
          {
            id: "release",
            statement: "  Release is published  ",
            status: "unknown",
          },
        ],
      },
    });

    expect(context).toEqual({
      schema_version: 1,
      number: 2,
      trigger: "retry",
      prior: {
        run_id: "wf-prior",
        causes: ["workflow_error", "acceptance_unknown"],
        error: "command failed",
        acceptance: { satisfied: 1, unsatisfied: 0, unknown: 1, total: 2 },
        unresolved: [{ id: "release", statement: "Release is published", status: "unknown" }],
      },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.prior)).toBe(true);
    expect(Object.isFrozen(context.prior?.causes)).toBe(true);
    expect(Object.isFrozen(context.prior?.acceptance)).toBe(true);
    expect(Object.isFrozen(context.prior?.unresolved)).toBe(true);
    expect(Object.isFrozen(context.prior?.unresolved[0])).toBe(true);
    expect(isCanonicalWorkflowAttemptContext(context)).toBe(true);
  });

  test("requires exact trigger/prior pairing and canonical failure evidence", () => {
    expect(() =>
      normalizeWorkflowAttemptContext({
        schema_version: 1,
        number: 1,
        trigger: "initial",
        prior: {
          run_id: "wf-prior",
          causes: ["lost"],
          unresolved: [],
        },
      }),
    ).toThrow(/initial.*prior/);
    expect(() =>
      normalizeWorkflowAttemptContext({
        schema_version: 1,
        number: 2,
        trigger: "retry",
      }),
    ).toThrow(/retry.*prior/);
    expect(() =>
      normalizeWorkflowAttemptContext({
        schema_version: 1,
        number: 2,
        trigger: "retry",
        prior: {
          run_id: "wf-prior",
          causes: ["lost", "workflow_error"],
          unresolved: [],
        },
      }),
    ).toThrow(/lost.*only/);
    expect(() =>
      normalizeWorkflowAttemptContext({
        schema_version: 1,
        number: 2,
        trigger: "retry",
        prior: {
          run_id: "wf-prior",
          causes: ["workflow_error", "workflow_error"],
          unresolved: [],
        },
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      normalizeWorkflowAttemptContext({
        schema_version: 1,
        number: 2,
        trigger: "retry",
        prior: {
          run_id: "wf-prior",
          causes: ["acceptance_unknown"],
          acceptance: { satisfied: 1, unsatisfied: 0, unknown: 0, total: 1 },
          unresolved: [],
        },
      }),
    ).toThrow(/does not match/);
  });
});
