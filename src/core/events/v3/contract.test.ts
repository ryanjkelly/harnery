import { describe, expect, test } from "bun:test";
import type { TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  EVENT_V3_CONTRACT_MAJOR,
  EVENT_V3_CORE_EVENT_TYPES,
  EventV3Schema,
  SpanSummaryV3Schema,
  WaitKindV3Schema,
} from "./contract.ts";

describe("event ledger V3 contract", () => {
  test("is an active major-three schema with native wait events", () => {
    expect(EVENT_V3_CONTRACT_MAJOR).toBe(3);
    expect(EVENT_V3_CORE_EVENT_TYPES).toContain("wait.started");
    expect(EVENT_V3_CORE_EVENT_TYPES).toContain("wait.ended");
    expect(EVENT_V3_CORE_EVENT_TYPES).toContain("health.capability_drift");
  });

  test("requires self-contained timing on every designated terminal", () => {
    for (const eventType of [
      "session.ended",
      "turn.completed",
      "tool.completed",
      "command.completed",
      "agent.completed",
      "wait.ended",
    ]) {
      const branch = eventBranch(eventType);
      const payload = branch.properties.payload as unknown as {
        required?: string[];
        properties: Record<string, unknown>;
      };
      expect(payload.required).toContain("span");
      expect(payload.properties.span).toEqual(SpanSummaryV3Schema);
    }
  });

  test("uses the guard-aligned active wait vocabulary", () => {
    for (const kind of [
      "permission",
      "needs_input",
      "decision",
      "approval",
      "scheduled",
      "rate_limit",
      "unknown",
    ]) {
      expect(Value.Check(WaitKindV3Schema, kind)).toBe(true);
    }
    for (const retired of ["operator_input", "dependency", "none"]) {
      expect(Value.Check(WaitKindV3Schema, retired)).toBe(false);
    }
  });

  test("adds turn economics as required Observation blocks", () => {
    const payload = eventBranch("turn.completed").properties.payload as {
      required?: string[];
    };
    expect(payload.required).toEqual(
      expect.arrayContaining(["usage", "inference", "harness", "span"]),
    );
  });

  test("makes delegation starts explicit child spans", () => {
    const links = eventBranch("agent.started").properties.links as {
      required?: string[];
    };
    expect(links.required).toEqual(expect.arrayContaining(["span_id", "parent_span_id"]));
  });
});

function eventBranch(eventType: string): TObject {
  const branches = (EventV3Schema as unknown as { anyOf: TObject[] }).anyOf;
  const branch = branches.find(({ properties }) => properties.event_type.const === eventType);
  if (!branch) throw new Error(`missing V3 event branch: ${eventType}`);
  return branch;
}
