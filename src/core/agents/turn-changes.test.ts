import { expect, test } from "bun:test";
import { eventV3Fixture, fixtureObject } from "../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "../events/v3/contract.ts";
import { formatTurnChanges, resolveTurnChanges } from "./turn-changes.ts";

const start = Date.parse("2026-09-11T10:00:00.000Z");
function event(
  type: string,
  second: number,
  turn = "turn-one",
  owner = "inst_operator",
  generation = "gen_one",
): EventV3 {
  const value = eventV3Fixture(type, second + 1);
  Object.assign(fixtureObject(value.scope), {
    instance_id: owner,
    generation_id: generation,
    turn_id: turn,
  });
  fixtureObject(value.time).observed_at = new Date(start + second * 1000).toISOString();
  fixtureObject(value.links).span_id = `span_${second}`;
  if (type === "tool.completed")
    fixtureObject(fixtureObject(value.payload).span).span_id = `span_${second}`;
  return value as unknown as EventV3;
}
function tool(
  second: number,
  added?: number,
  removed = 0,
  turn = "turn-one",
  owner = "inst_operator",
): EventV3 {
  const value = event("tool.completed", second, turn, owner);
  Object.assign(fixtureObject(value.payload), {
    outcome: "succeeded",
    line_changes:
      added === undefined
        ? undefined
        : {
            state: "observed",
            value: { added, removed },
            attestation: "derived",
            confidence: "high",
          },
  });
  return value;
}
function resolve(events: EventV3[]) {
  return resolveTurnChanges(events, "inst_operator", start + 600_000);
}

test("selects the current turn and excludes peers, older turns, and late old-turn tools", () => {
  expect(
    resolve([
      event("turn.started", 0),
      tool(1, 100),
      event("turn.started", 10, "turn-two"),
      tool(11, 2, 1, "turn-two"),
      tool(12, 500, 0, "turn-one"),
      tool(13, 800, 0, "turn-two", "inst_peer"),
    ]),
  ).toEqual({ added: 2, removed: 1, measured_tools: 1, unmeasured_tools: 0 });
});

test("keeps edits after completion and deduplicates repeated terminal evidence", () => {
  const edit = tool(1, 12, 4);
  expect(resolve([event("turn.started", 0), edit, edit, event("turn.completed", 2)])).toEqual({
    added: 12,
    removed: 4,
    measured_tools: 1,
    unmeasured_tools: 0,
  });
});

test("folds remediation into the same operator turn but never across generations", () => {
  const restart = event("turn.started", 10, "turn-two");
  fixtureObject(restart.payload).stop_remediation = true;
  expect(
    resolve([event("turn.started", 0), tool(1, 5), restart, tool(11, 3, 1, "turn-two")]),
  ).toEqual({ added: 8, removed: 1, measured_tools: 2, unmeasured_tools: 0 });
  fixtureObject(restart.scope).generation_id = "gen_two";
  expect(resolve([event("turn.started", 0), tool(1, 5), restart])).toBeNull();
});

test("failed tools, shell tools, and unpaired requests make the count partial", () => {
  const failed = tool(2, 400);
  fixtureObject(failed.payload).outcome = "failed";
  const changes = resolve([
    event("turn.started", 0),
    tool(1, 5, 2),
    failed,
    tool(3),
    event("tool.requested", 4),
  ]);
  expect(changes).toEqual({ added: 5, removed: 2, measured_tools: 1, unmeasured_tools: 3 });
  expect(formatTurnChanges(changes)).toBe("+5 / -2 lines (partial; unmeasured tools)");
});

test("missing evidence stays unavailable while measured read-only tools report zero", () => {
  expect(formatTurnChanges(resolve([event("turn.started", 0)]))).toContain("unavailable");
  expect(formatTurnChanges(resolve([event("turn.started", 0), tool(1)]))).toContain("unavailable");
  expect(formatTurnChanges(resolve([event("turn.started", 0), tool(1, 0)]))).toBe(
    "+0 / -0 lines (recorded edits)",
  );
});
