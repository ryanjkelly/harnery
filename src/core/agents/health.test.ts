import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { collectCoordinationHealthSnapshot } from "./health.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
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
  test("reports a missing, unsafe or empty active file", () => {
    const missing = ledgerRoot();
    expect(collectCoordinationHealthSnapshot(missing).capability.state).not.toBe("supported");
    expect(JSON.stringify(collectCoordinationHealthSnapshot(missing))).toContain("ledger-missing");

    const unsafe = ledgerRoot();
    const target = join(unsafe, "elsewhere.ndjson");
    writeFileSync(target, "");
    symlinkSync(target, join(unsafe, ".harnery/ledgers/v3/active.ndjson"));
    expect(JSON.stringify(collectCoordinationHealthSnapshot(unsafe))).toContain("ledger-unsafe");

    const empty = ledgerRoot();
    writeFileSync(join(empty, ".harnery/ledgers/v3/active.ndjson"), "");
    const snapshot = collectCoordinationHealthSnapshot(empty);
    expect(snapshot.capability.state).toBe("supported");
    expect(snapshot.recent_events).toEqual([]);
    expect(snapshot.omitted_event_count).toBe(0);
  });

  test("reads only the bounded tail and drops its partial first line", () => {
    const root = ledgerRoot();
    const line = `${JSON.stringify(event("evt_pad", "tool.completed", 1))}\n`;
    const lines: string[] = [];
    let size = 0;
    for (let index = 0; size <= 300 * 1_024; index += 1) {
      const next = `${JSON.stringify(event(`evt_${index}`, "tool.completed", index))}\n`;
      lines.push(next);
      size += Buffer.byteLength(next);
    }
    writeFileSync(join(root, ".harnery/ledgers/v3/active.ndjson"), line + lines.join(""));
    const snapshot = collectCoordinationHealthSnapshot(root);
    expect(snapshot.capability.state).toBe("supported");
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.recent_events).toHaveLength(64);
    expect(snapshot.recent_events.at(-1)).toEqual(
      expect.objectContaining({ record_id: `evt_${lines.length - 1}` }),
    );
    expect(snapshot.omitted_event_count).toBeGreaterThan(1);
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
