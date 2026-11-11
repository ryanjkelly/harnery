import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import {
  asEventV3,
  causalCycleScenarioV3,
  clockRegressionScenarioV3,
  initializeReplayLedgerV3,
  latePredecessorScenarioV3,
  plantCommittedReceiptV3,
  plantReadyRowV3,
  plantUnreadableSpoolFileV3,
  replayRootV3,
  sequenceGapScenarioV3,
  spoolNamesV3,
  waitingClaimSweepScenarioV3,
} from "./__fixtures__/ledger-replay.ts";
import { readEventV3ControlState } from "./control.ts";
import { readLedgerV3 } from "./reader.ts";
import { drainReadyEventsV3, eventV3Paths, writeEventV3 } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

/** Body for a door-check case the writer does not implement yet. */
const pendingDoor = () => {
  throw new Error("pending: the writer's drain does not run the shared row check yet");
};

describe("event ledger V3 door check: a bad row stops only its own session (b)", () => {
  test("today: draining another session's write appends X's sequence gap and fails the ledger", () => {
    // The door-check work replaces this: X's row must wait and the ledger stay valid.
    const root = initializedRoot();
    const scenario = sequenceGapScenarioV3();
    for (const event of scenario.committed) {
      expect(writeEventV3(root, asEventV3(event)).state).toBe("committed");
    }
    expect(writeEventV3(root, asEventV3(scenario.x_waiting), { deferDrain: true }).state).toBe(
      "ready",
    );
    expect(writeEventV3(root, asEventV3(scenario.y_task)).state).toBe("committed");

    const read = readLedgerV3(root);
    expect(read.complete).toBe(false);
    expect(read.diagnostics).toEqual([
      expect.objectContaining({
        code: "producer_sequence_gap",
        event_id: scenario.x_waiting.event_id as string,
      }),
    ]);
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });
  });

  test("the waiting-claim fixture has a sweeper release the claim X still has queued", () => {
    const scenario = waitingClaimSweepScenarioV3();
    const acquisition = scenario.x_claim_waiting.payload as Record<string, unknown>;
    const release = scenario.sweep_release.payload as Record<string, unknown>;
    expect(acquisition).toMatchObject({
      operation: "acquired",
      subject_instance_id: scenario.x.instance_id,
    });
    expect(release).toMatchObject({
      operation: "released",
      actor_instance_id: scenario.sweeper.instance_id,
      subject_instance_id: scenario.x.instance_id,
    });
    expect((scenario.sweep_release.links as { caused_by: string[] }).caused_by).toEqual([
      scenario.x_claim_waiting.event_id as string,
    ]);
    // X skipped one producer sequence before both of its waiting rows.
    const sequence = (event: Record<string, unknown>) =>
      (event.producer as { sequence: number }).sequence;
    expect(sequence(scenario.x_waiting)).toBe(sequence(scenario.x_missing) + 1);
    expect(sequence(scenario.x_claim_waiting)).toBe(sequence(scenario.x_waiting) + 1);
  });

  test.todo(
    "a sequence gap in X's queued rows leaves the ledger with no reader diagnostic",
    pendingDoor,
  );
  test.todo(
    "writeEventV3 returns waiting with reason producer_sequence_gap for X's row",
    pendingDoor,
  );
  test.todo("Y sets a task, claims a file and finishes its turn while X's rows wait", pendingDoor);
  test.todo(
    "X's waiting rows stay in the queue, and X records again after a rotation",
    pendingDoor,
  );
  test.todo(
    "agents health names X's generation, the reason, the first waiting sequence and its age",
    pendingDoor,
  );
  test.todo(
    "a stale sweep emits no release for X's generation while X's claim acquisition waits, and retries once it has none",
    pendingDoor,
  );
  test.todo(
    "the waiting-claim sweep scenario ends with no reader or projection diagnostic",
    pendingDoor,
  );
});

describe("event ledger V3 door check: rows the reader would reject (c)", () => {
  test("today: an unmarked clock regression is appended and fails the ledger", () => {
    // The door-check work replaces this: the regressed row must wait in the queue.
    const root = initializedRoot();
    const scenario = clockRegressionScenarioV3();
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    expect(writeEventV3(root, asEventV3(scenario.clock_regressed)).state).toBe("committed");
    expect(readLedgerV3(root).diagnostics.map(({ code }) => code)).toEqual([
      "wall_clock_regression_unmarked",
      "monotonic_clock_regression",
    ]);
  });

  test("today: a row queued ahead of its producer predecessor is appended with a gap", () => {
    // The door-check work replaces this: the successor waits until its predecessor arrives.
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    expect(writeEventV3(root, asEventV3(scenario.successor)).state).toBe("committed");
    expect(readLedgerV3(root).diagnostics.map(({ code }) => code)).toEqual([
      "producer_sequence_gap",
    ]);
  });

  test("a replayed row whose ID is already committed passes and leaves the ledger valid", () => {
    // Crash replay: a receipt left behind after the append. This must keep passing.
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("committed");
    plantCommittedReceiptV3(spool(root), scenario.start);
    expect(drainReadyEventsV3(root)).toBe(1);
    const read = readLedgerV3(root);
    expect(read.complete).toBe(true);
    expect(
      read.events.filter(({ event }) => event.event_id === scenario.start.event_id),
    ).toHaveLength(1);
    expect(spoolNamesV3(spool(root), ".committed")).toEqual([]);
  });

  test("today: a causal cycle stops the drain, so the admissible row beside it waits too", () => {
    // The door-check work replaces this: the admissible row is appended and the cycle waits.
    const root = initializedRoot();
    const scenario = causalCycleScenarioV3();
    const before = readFileSync(eventV3Paths(root).active, "utf8");
    for (const event of [...scenario.cycle, scenario.admissible])
      plantReadyRowV3(spool(root), event);
    expect(() => drainReadyEventsV3(root)).toThrow("causal dependency cycle");
    expect(readFileSync(eventV3Paths(root).active, "utf8")).toBe(before);
    expect(spoolNamesV3(spool(root), ".ready")).toHaveLength(3);
  });

  test("today: one unreadable queued file stalls every session's drain", () => {
    // The door-check work replaces this: the file is set aside and the drain continues.
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    const unreadable = plantUnreadableSpoolFileV3(spool(root), "ready");
    const result = writeEventV3(root, asEventV3(scenario.start));
    expect(result).toMatchObject({ state: "ready", diagnostic_code: "wal_drain_failed" });
    expect(() => drainReadyEventsV3(root)).toThrow();
    expect(existsSync(unreadable)).toBe(true);
    expect(spoolNamesV3(spool(root), ".ready")).toHaveLength(2);
  });

  test("today: one unreadable committed receipt stalls every session's drain", () => {
    // The door-check work replaces this: the receipt is set aside and the drain continues.
    const root = initializedRoot();
    const scenario = latePredecessorScenarioV3();
    const unreadable = plantUnreadableSpoolFileV3(spool(root), "committed");
    expect(writeEventV3(root, asEventV3(scenario.start)).state).toBe("ready");
    expect(() => drainReadyEventsV3(root)).toThrow();
    expect(existsSync(unreadable)).toBe(true);
  });

  test.todo(
    "an unmarked clock regression waits in the queue with reason wall_clock_regression_unmarked",
    pendingDoor,
  );
  test.todo(
    "a row whose producer predecessor arrives late waits, then both are admitted in producer order",
    pendingDoor,
  );
  test.todo(
    "a causal cycle waits in the queue while the admissible row beside it is appended",
    pendingDoor,
  );
  test.todo(
    "an unreadable queued file is set aside and reported, other sessions' rows are appended, and nothing is deleted",
    pendingDoor,
  );
  test.todo(
    "an unreadable committed receipt is set aside and reported without stopping the drain",
    pendingDoor,
  );
  test.todo(
    "writeEventV3 returns set_aside with a reason for a file that can never be appended",
    pendingDoor,
  );
});

function initializedRoot(): string {
  const root = replayRootV3("harnery-v3-door-check-");
  roots.push(root);
  initializeReplayLedgerV3(root);
  return root;
}

function spool(root: string): string {
  return eventV3Paths(root).spool;
}
