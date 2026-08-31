import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCoordinationHealthSnapshot } from "./health.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bounded coordination health", () => {
  test("returns reference-only active-tail evidence", () => {
    const root = ledgerRoot();
    writeFileSync(
      join(root, ".harnery/ledgers/v3/active.ndjson"),
      `${JSON.stringify(event("evt_test", "tool.completed", 7))}\n`,
    );
    const snapshot = collectCoordinationHealthSnapshot(root, new Date("2026-08-30T12:00:01.000Z"));
    expect(snapshot.capability.state).toBe("supported");
    expect(snapshot.recent_events).toEqual([
      expect.objectContaining({ record_id: "evt_test", source_id: "tool.completed", sequence: 7 }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private payload");
  });

  test("reports malformed tail frames without throwing", () => {
    const root = ledgerRoot();
    writeFileSync(join(root, ".harnery/ledgers/v3/active.ndjson"), "not-json\n");
    const snapshot = collectCoordinationHealthSnapshot(root);
    expect(snapshot.capability.state).toBe("partial");
    expect(snapshot.diagnostics[0]?.code).toBe("malformed_json");
  });
});

function ledgerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-coordination-health-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery/ledgers/v3"), { recursive: true });
  return root;
}

function event(eventId: string, eventType: string, sequence: number) {
  return {
    contract: { major: 3 },
    event_id: eventId,
    event_type: eventType,
    time: { observed_at: "2026-08-30T12:00:00.000Z" },
    producer: { sequence },
    payload: "private payload",
  };
}
