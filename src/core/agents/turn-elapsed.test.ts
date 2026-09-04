import { describe, expect, test } from "bun:test";
import { eventV3Fixture, fixtureObject } from "../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "../events/v3/contract.ts";
import { formatTurnElapsed, resolveTurnElapsed } from "./turn-elapsed.ts";

const OWNER = "inst_operator";
const GENERATION = "gen_00000000-0000-7000-8000-000000000001";
const START = Date.parse("2026-09-03T22:00:00.000Z");

function event(eventType: string, second: number, generation = GENERATION): EventV3 {
  const value = eventV3Fixture(eventType, second + 1);
  const scope = fixtureObject(value.scope);
  scope.instance_id = OWNER;
  scope.generation_id = generation;
  const time = fixtureObject(value.time);
  const stamp = new Date(START + second * 1_000).toISOString();
  time.observed_at = stamp;
  time.recorded_at = stamp;
  return value as unknown as EventV3;
}

function turnStarted(second: number, stopRemediation = false, generation = GENERATION): EventV3 {
  const value = event("turn.started", second, generation);
  fixtureObject(value.payload).stop_remediation = stopRemediation;
  return value;
}

function at(second: number): number {
  return START + second * 1_000;
}

describe("resolveTurnElapsed", () => {
  test("measures an open turn to now", () => {
    const elapsed = resolveTurnElapsed([turnStarted(0)], OWNER, at(95));
    expect(elapsed).toEqual({ secs: 95, complete: false, remediation_restarts: 0 });
  });

  test("measures a closed turn to its terminal, not to now", () => {
    const events = [turnStarted(0), event("turn.completed", 40)];
    const elapsed = resolveTurnElapsed(events, OWNER, at(600));
    expect(elapsed).toEqual({ secs: 40, complete: true, remediation_restarts: 0 });
  });

  test("folds Stop-hook remediation restarts into one operator turn", () => {
    const events = [
      turnStarted(0),
      event("turn.completed", 30),
      turnStarted(35, true),
      event("turn.completed", 50),
      turnStarted(55, true),
    ];
    const elapsed = resolveTurnElapsed(events, OWNER, at(70));
    expect(elapsed).toEqual({ secs: 70, complete: false, remediation_restarts: 2 });
  });

  test("stops the remediation walk at a generation boundary", () => {
    const events = [
      turnStarted(0, false, "gen_00000000-0000-7000-8000-000000000002"),
      turnStarted(50, true),
    ];
    const elapsed = resolveTurnElapsed(events, OWNER, at(60));
    expect(elapsed).toEqual({ secs: 10, complete: false, remediation_restarts: 0 });
  });

  test("ignores turns owned by another session", () => {
    const foreign = turnStarted(0);
    fixtureObject(foreign.scope).instance_id = "inst_peer";
    expect(resolveTurnElapsed([foreign], OWNER, at(60))).toBeNull();
  });

  test("ignores a turn.started stamped after now", () => {
    expect(resolveTurnElapsed([turnStarted(90)], OWNER, at(60))).toBeNull();
  });

  test("returns null without turn evidence", () => {
    expect(resolveTurnElapsed([event("tool.requested", 5)], OWNER, at(60))).toBeNull();
  });

  test("ignores a terminal recorded before the turn started", () => {
    const events = [event("turn.completed", 5), turnStarted(10)];
    const elapsed = resolveTurnElapsed(events, OWNER, at(20));
    expect(elapsed).toEqual({ secs: 10, complete: false, remediation_restarts: 0 });
  });
});

describe("formatTurnElapsed", () => {
  test("keeps seconds visible below an hour", () => {
    expect(formatTurnElapsed(0)).toBe("0s");
    expect(formatTurnElapsed(59)).toBe("59s");
    expect(formatTurnElapsed(60)).toBe("1m 0s");
    expect(formatTurnElapsed(252)).toBe("4m 12s");
  });

  test("drops to hours and minutes above an hour", () => {
    expect(formatTurnElapsed(3600)).toBe("1h 0m");
    expect(formatTurnElapsed(3780)).toBe("1h 3m");
  });
});
