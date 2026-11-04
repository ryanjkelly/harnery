import { describe, expect, test } from "bun:test";
import { eventV3Fixture, fixtureObject } from "../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "../events/v3/contract.ts";
import { resolveTurnElapsed } from "./turn-elapsed.ts";
import { MAX_TURN_CONTINUATIONS, resolveTurnRange } from "./turn-range.ts";

const OWNER = "inst_operator";
const GENERATION = "gen_00000000-0000-7000-8000-000000000001";
const TIME = Date.parse("2026-11-04T12:00:00.000Z");
const tid = (ordinal: number) => `tid_${ordinal.toString(16).padStart(64, "0")}`;

function start(second: number, ordinal: number, continued?: number, generation = GENERATION) {
  const value = eventV3Fixture("turn.started", ordinal + 1);
  Object.assign(fixtureObject(value.scope), {
    instance_id: OWNER,
    generation_id: generation,
    turn_id: tid(ordinal),
  });
  fixtureObject(value.time).observed_at = new Date(TIME + second * 1000).toISOString();
  if (continued !== undefined) fixtureObject(value.payload).continues_turn_id = tid(continued);
  return value as unknown as EventV3;
}

describe("resolveTurnRange", () => {
  test("links multiple adjacent recoveries with a single bounded resolver", () => {
    const range = resolveTurnRange(
      [start(0, 1), start(10, 2, 1), start(20, 3, 2)],
      OWNER,
      TIME + 30_000,
    );
    expect(range?.starts.map((event) => event.scope.turn_id)).toEqual([tid(1), tid(2), tid(3)]);
    expect(range?.continuationCount).toBe(2);
    expect(range?.startMs).toBe(TIME);
  });

  test("a new operator prompt prevents a late recovery from absorbing its predecessor", () => {
    const events = [start(0, 1), start(100, 2), start(110, 3, 1), start(120, 4, 3)];
    const range = resolveTurnRange(events, OWNER, TIME + 130_000);
    expect(range?.latest.scope.turn_id).toBe(tid(2));
    expect([...range!.ignoredTurnIds]).toEqual([tid(3), tid(4)]);
    expect(resolveTurnElapsed(events, OWNER, TIME + 130_000)).toEqual({
      secs: 30,
      complete: false,
      remediation_restarts: 0,
    });
  });

  test("a legitimate continuation follows the last accepted start past an ignored late recovery", () => {
    const events = [start(0, 1), start(100, 2), start(110, 3, 1), start(120, 4, 2)];
    const range = resolveTurnRange(events, OWNER, TIME + 130_000);
    expect(range?.starts.map((event) => event.scope.turn_id)).toEqual([tid(2), tid(4)]);
    expect([...range!.ignoredTurnIds]).toEqual([tid(3)]);
    expect(resolveTurnElapsed(events, OWNER, TIME + 130_000)).toEqual({
      secs: 30,
      complete: false,
      remediation_restarts: 1,
    });
  });

  test("unknown links and generation boundaries do not merge starts", () => {
    const unknown = resolveTurnRange([start(10, 2, 1)], OWNER, TIME + 20_000);
    expect(unknown?.continuationCount).toBe(0);
    const replacement = start(10, 2, 1, "gen_00000000-0000-7000-8000-000000000002");
    expect(resolveTurnRange([start(0, 1), replacement], OWNER, TIME + 20_000)?.startMs).toBe(
      TIME + 10_000,
    );
  });

  test("one cap limits long continuation chains for every consumer", () => {
    const events = Array.from({ length: MAX_TURN_CONTINUATIONS + 4 }, (_, index) =>
      start(index, index + 1, index > 0 ? index : undefined),
    );
    const range = resolveTurnRange(events, OWNER, TIME + 60_000);
    expect(range?.continuationCount).toBe(MAX_TURN_CONTINUATIONS);
    expect(resolveTurnElapsed(events, OWNER, TIME + 60_000)?.remediation_restarts).toBe(
      MAX_TURN_CONTINUATIONS,
    );
  });
});
