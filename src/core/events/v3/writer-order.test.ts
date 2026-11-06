import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EventV3Fixture,
  eventV3Fixture,
  fixtureObject,
} from "../../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "./contract.ts";
import { readLedgerFramesV3 } from "./reader.ts";
import {
  drainReadyEventsV3,
  eventV3Paths,
  withEventV3LedgerLease,
  writeEventV3,
} from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V3 causal append ordering", () => {
  test("nested publishers share ownership until the outer row is published", () => {
    const root = temporaryRoot();
    const parent = fixture("tool.requested", 1, "prd_hook", 1);
    const child = fixture("command.started", 2, "prd_command", 1);
    fixtureObject(child.links).caused_by = [parent.event_id];
    const current = join(root, ".harnery", "private", "event-v3-publication-lease", "current");

    const result = writeEventV3(root, parent as unknown as EventV3, {
      onStep: (step) => {
        if (step !== "ready_temp_flushed") return;
        const owner = readFileSync(current, "utf8");
        expect(
          writeEventV3(join(root, "."), child as unknown as EventV3, { deferDrain: true }).state,
        ).toBe("ready");
        expect(readFileSync(current, "utf8")).toBe(owner);
        expect(activeEvents(root)).toEqual([]);
      },
    });

    expect(result.state).toBe("committed");
    expect(existsSync(current)).toBeFalse();
    expect(activeEvents(root).map(({ event_id }) => event_id)).toEqual([
      parent.event_id,
      child.event_id,
    ]);
  });

  test("nested publication failures retain outer ownership and release it on unwind", () => {
    const root = temporaryRoot();
    const parent = fixture("tool.requested", 1, "prd_hook", 1);
    const child = fixture("command.started", 2, "prd_command", 1);
    const current = join(root, ".harnery", "private", "event-v3-publication-lease", "current");

    expect(() =>
      writeEventV3(root, parent as unknown as EventV3, {
        onStep: (step) => {
          if (step !== "ready_temp_flushed") return;
          const owner = readFileSync(current, "utf8");
          expect(() =>
            writeEventV3(root, child as unknown as EventV3, {
              onStep: () => {
                throw new Error("nested publication interrupted");
              },
            }),
          ).toThrow("nested publication interrupted");
          expect(readFileSync(current, "utf8")).toBe(owner);
          throw new Error("outer publication interrupted");
        },
      }),
    ).toThrow("outer publication interrupted");

    expect(existsSync(current)).toBeFalse();
    expect(readdirSync(eventV3Paths(root).spool)).toEqual([]);
    expect(writeEventV3(root, parent as unknown as EventV3).state).toBe("committed");
  });

  test("another process cannot borrow a publisher's lease and succeeds after release", () => {
    const root = temporaryRoot();
    const parent = fixture("tool.requested", 1, "prd_hook", 1);
    const child = fixture("command.started", 2, "prd_command", 1);
    const script = `
      import { writeEventV3 } from ${JSON.stringify(new URL("./writer.ts", import.meta.url).href)};
      try {
        console.log(JSON.stringify(writeEventV3(${JSON.stringify(root)}, ${JSON.stringify(child)})));
      } catch (error) {
        console.log(JSON.stringify({ error: error.message }));
      }
    `;
    const publishFromPeer = () => {
      const peer = Bun.spawnSync({
        cmd: [process.execPath, "--eval", script],
        timeout: 10_000,
      });
      expect(peer.exitCode).toBe(0);
      return JSON.parse(peer.stdout.toString());
    };
    expect(
      writeEventV3(root, parent as unknown as EventV3, {
        onStep: (step) => {
          if (step !== "ready_temp_flushed") return;
          expect(publishFromPeer()).toMatchObject({
            error: expect.stringContaining("lease event-v3-publication is held"),
          });
          expect(activeEvents(root)).toEqual([]);
        },
      }).state,
    ).toBe("committed");
    expect(publishFromPeer()).toMatchObject({ state: "committed" });
    expect(activeEvents(root).map(({ event_id }) => event_id)).toEqual([
      parent.event_id,
      child.event_id,
    ]);
  });

  test("defers ready rows and drains the complete causal batch later", () => {
    const root = temporaryRoot();
    const parent = fixture("tool.requested", 1, "prd_hook", 1);
    const child = fixture("command.started", 2, "prd_command", 1);
    fixtureObject(child.links).caused_by = [parent.event_id];

    expect(writeEventV3(root, parent as unknown as EventV3, { deferDrain: true }).state).toBe(
      "ready",
    );
    expect(writeEventV3(root, child as unknown as EventV3, { deferDrain: true }).state).toBe(
      "ready",
    );
    expect(activeEvents(root)).toEqual([]);

    expect(drainReadyEventsV3(root)).toBe(2);
    expect(activeEvents(root).map(({ event_id }) => event_id)).toEqual([
      parent.event_id,
      child.event_id,
    ]);
  });

  test("commits a ready causal parent before its child across producers", () => {
    const root = temporaryRoot();
    const parent = fixture("tool.requested", 3, "prd_hook", 99);
    const child = fixture("command.started", 1, "prd_command", 1);
    fixtureObject(child.links).caused_by = [parent.event_id];

    withEventV3LedgerLease(root, {}, () => {
      expect(writeEventV3(root, child as unknown as EventV3).state).toBe("ready");
      expect(writeEventV3(root, parent as unknown as EventV3).state).toBe("ready");
    });
    expect(drainReadyEventsV3(root)).toBe(2);

    const events = activeEvents(root);
    expect(events.map(({ event_id }) => event_id)).toEqual([parent.event_id, child.event_id]);
    const read = readLedgerFramesV3(
      events.map((event, index) => ({
        raw: JSON.stringify(event),
        position: { segment_ordinal: 1, byte_offset: index * 1_000 },
      })),
    );
    expect(read.diagnostics.map(({ code }) => code)).not.toContain("causal_parent_missing");
  });

  test("allows a peer terminal between a committed parent and later child", () => {
    const root = temporaryRoot();
    const parent = fixture("tool.requested", 10, "prd_hook", 1);
    const peer = fixture("session.ended", 11, "prd_peer", 1);
    const child = fixture("command.started", 12, "prd_command", 1);
    fixtureObject(child.links).caused_by = [parent.event_id];

    writeEventV3(root, parent as unknown as EventV3);
    writeEventV3(root, peer as unknown as EventV3);
    writeEventV3(root, child as unknown as EventV3);

    const events = activeEvents(root);
    expect(events.map(({ event_id }) => event_id)).toEqual([
      parent.event_id,
      peer.event_id,
      child.event_id,
    ]);
    const read = readLedgerFramesV3(
      events.map((event, index) => ({
        raw: JSON.stringify(event),
        position: { segment_ordinal: 1, byte_offset: index * 1_000 },
      })),
    );
    expect(read.diagnostics.map(({ code }) => code)).not.toContain("causal_parent_missing");
  });

  test("leaves a causal cycle in the WAL without touching active storage", () => {
    const root = temporaryRoot();
    const first = fixture("health.capability_drift", 20, "prd_first", 1);
    const second = fixture("health.capability_drift", 21, "prd_second", 1);
    fixtureObject(first.links).caused_by = [second.event_id];
    fixtureObject(second.links).caused_by = [first.event_id];

    withEventV3LedgerLease(root, {}, () => {
      expect(writeEventV3(root, first as unknown as EventV3).state).toBe("ready");
      expect(writeEventV3(root, second as unknown as EventV3).state).toBe("ready");
    });
    expect(() => drainReadyEventsV3(root)).toThrow("causal dependency cycle");
    expect(readFileSync(eventV3Paths(root).active, "utf8")).toBe("");
    expect(
      readdirSync(eventV3Paths(root).spool).filter((name) => name.endsWith(".ready")),
    ).toHaveLength(2);
  });
});

function fixture(
  eventType: string,
  fixtureSequence: number,
  producerId: string,
  producerSequence: number,
): EventV3Fixture {
  const event = eventV3Fixture(eventType, fixtureSequence);
  const producer = fixtureObject(event.producer);
  producer.producer_id = producerId;
  producer.boot_id = `boot_${producerId}`;
  producer.sequence = producerSequence;
  return event;
}

function activeEvents(root: string): EventV3Fixture[] {
  const raw = readFileSync(eventV3Paths(root).active, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((row) => JSON.parse(row) as EventV3Fixture);
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-writer-order-"));
  roots.push(root);
  return root;
}
