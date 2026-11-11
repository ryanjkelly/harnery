import { describe, expect, test } from "bun:test";
import { eventV3Fixture, fixtureObject } from "../../../../tests/helpers/event-v3.ts";
import { projectPresenceCodecDigests } from "../../presence/codec-digest.ts";
import type { EventV3 } from "./contract.ts";
import { reduceSafetyProjectionV3 } from "./projection.ts";
import type { ReadLedgerV3Result } from "./reader.ts";

describe("commands with no turn in the session projections", () => {
  test("a command outside any turn leaves the session idle", () => {
    const { start, command } = sessionWithCommand({ turn: false });
    const projection = reduceSafetyProjectionV3(readOf(start, command));
    expect(projection.diagnostics).toEqual([]);
    expect(generationActivity(projection, start)).toBe("idle");
  });

  test("a command inside a turn still marks the session working", () => {
    const { start, command } = sessionWithCommand({ turn: true });
    const projection = reduceSafetyProjectionV3(readOf(start, command));
    expect(projection.diagnostics).toEqual([]);
    expect(generationActivity(projection, start)).toBe("working");
  });

  test("the presence digest counts a command with no turn as a session action", () => {
    const { start, command, completed } = sessionWithCommand({ turn: false });
    const instanceId = (start.scope as { instance_id: string }).instance_id;
    const running = projectPresenceCodecDigests([start, command]).get(instanceId);
    expect(running?.operation?.event_id).toBe(command.event_id);
    const done = projectPresenceCodecDigests([start, command, completed]).get(instanceId);
    expect(done?.recent_actions.map((action) => action.event_id)).toEqual([completed.event_id]);
    expect(done?.operation).toBeUndefined();
  });
});

function sessionWithCommand(options: { turn: boolean }) {
  const start = eventV3Fixture("session.started", 1) as unknown as EventV3;
  const scope = fixtureObject(start.scope);
  // A command recorded against its session carries no turn_id.
  const command = eventV3Fixture("command.started", 2) as unknown as EventV3;
  const completed = eventV3Fixture("command.completed", 3) as unknown as EventV3;
  for (const event of [command, completed]) {
    const target = fixtureObject(event.scope);
    target.instance_id = scope.instance_id;
    target.session_id = scope.session_id;
    target.generation_id = scope.generation_id;
    if (options.turn) target.turn_id = `tid_${"a".repeat(64)}`;
    else delete target.turn_id;
    (event as { attestation_id?: string }).attestation_id = start.attestation_id;
    fixtureObject(event.links).caused_by = [start.event_id];
  }
  fixtureObject(completed.links).span_id = fixtureObject(command.links).span_id;
  return { start, command, completed };
}

function generationActivity(
  projection: ReturnType<typeof reduceSafetyProjectionV3>,
  start: EventV3,
): string | undefined {
  const generationId = (start.scope as { generation_id: string }).generation_id;
  return projection.generations[generationId]?.activity;
}

function readOf(...events: EventV3[]): ReadLedgerV3Result {
  return {
    events: events.map((event, index) => ({
      event,
      position: { segment_ordinal: 1, byte_offset: index * 100 },
    })),
    diagnostics: [],
    complete: true,
    bytes: 0,
  } as ReadLedgerV3Result;
}
