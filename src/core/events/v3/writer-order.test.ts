import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
