import { describe, expect, test } from "bun:test";

import type { AgentsSnapshot, Heartbeat } from "@/lib/coord-reader";
import { type CodecCardCapture, captureCodecCards, compareCodecCards } from "./card-audit";
import type { CodecScene } from "./contracts";

const NOW = "2026-09-25T05:00:00.000Z";

function row(overrides: Partial<Heartbeat> = {}): Heartbeat {
  return {
    instance_id: "native-1",
    v3_instance_id: "inst-1",
    name: "Ada",
    last_heartbeat: NOW,
    files_touched: [],
    activity: "working",
    task_state: "active",
    age_seconds: 0,
    task: "Build Codec",
    task_state_updated_at: NOW,
    ledger_state: "live",
    ...overrides,
  };
}

function authority(active: Heartbeat[], terminal: Heartbeat[] = []): AgentsSnapshot {
  return {
    active,
    stale: [],
    terminal,
    claims: [],
    meta: {
      scanned_dir: "/tmp",
      count: active.length,
      invalid: [],
      stale_threshold_seconds: 300,
      read_state: { ok: true },
    },
  };
}

function capture(): CodecCardCapture {
  return {
    captured_at: NOW,
    scene_generated_at: NOW,
    cards: [
      {
        instance_id: "native-1",
        display_name: "Ada",
        task: "Build Codec",
        presence: "online",
        activity: "working",
        lifecycle: "active",
        ledger_state: "live",
        updated_at: NOW,
      },
    ],
  };
}

describe("Codec card snapshot comparison", () => {
  test("captures the scene fields actually driving the cards", () => {
    const scene = {
      generated_at: NOW,
      panels: [
        {
          instance_id: "native-1",
          identity: { display_name: "Ada", task: { value: "Build Codec" } },
          presence: { value: "online" },
          activity: { value: "working" },
          lifecycle: { value: "active" },
          ledger_state: { value: "live" },
          updated_at: NOW,
        },
      ],
    } as unknown as CodecScene;
    expect(captureCodecCards(scene, NOW)).toEqual(capture());
  });

  test("matches an aliased, fresh authoritative agent", () => {
    const report = compareCodecCards(capture(), authority([row()]), NOW);
    expect(report.findings).toEqual([]);
    expect(report.summary).toEqual({ checked: 1, mismatches: 0, unverified: 0 });
  });

  test("flags a card retained after its ledger generation ended", () => {
    const report = compareCodecCards(
      capture(),
      authority([], [row({ ledger_state: "terminal" })]),
      NOW,
    );
    expect(report.findings).toMatchObject([
      { field: "card", known: "terminal", severity: "mismatch" },
    ]);
  });

  test("reports individual state differences and a missing active card", () => {
    const changed = row({ activity: "idle", task: "Review Codec", task_state: "done" });
    const missing = row({ instance_id: "native-2", v3_instance_id: "inst-2", name: "Bea" });
    const report = compareCodecCards(capture(), authority([changed, missing]), NOW);
    expect(report.findings.map((finding) => finding.field)).toEqual([
      "activity",
      "task",
      "lifecycle",
      "card",
    ]);
  });

  test("marks unsupported comparisons unverified instead of inventing a mismatch", () => {
    const snapshot = authority([]);
    snapshot.meta.read_state = { ok: false, reason: "ledger unavailable" };
    const report = compareCodecCards(capture(), snapshot, NOW);
    expect(report.summary).toEqual({ checked: 0, mismatches: 0, unverified: 1 });
    expect(report.findings[0]?.explanation).toBe("ledger unavailable");
  });

  test("marks remote cards unverified even when local authority is healthy", () => {
    const remoteCapture = capture();
    remoteCapture.cards = remoteCapture.cards.map((card) => ({ ...card, machine: "remote" }));
    const report = compareCodecCards(remoteCapture, authority([]), NOW);
    expect(report.summary).toEqual({ checked: 0, mismatches: 0, unverified: 1 });
    expect(report.findings[0]).toMatchObject({ field: "authority", severity: "unverified" });
  });

  test("keeps remote cards unverified when local authority fails", () => {
    const mixed = capture();
    mixed.cards.push({ ...mixed.cards[0]!, instance_id: "remote-1", machine: "remote" });
    const snapshot = authority([]);
    snapshot.meta.read_state = { ok: false, reason: "ledger unavailable" };
    const report = compareCodecCards(mixed, snapshot, NOW);
    expect(report.summary).toEqual({ checked: 0, mismatches: 0, unverified: 2 });
    expect(report.findings).toHaveLength(2);
  });

  test("a remote card cannot satisfy a missing local card with the same alias", () => {
    const remoteCapture = capture();
    remoteCapture.cards = remoteCapture.cards.map((card) => ({
      ...card,
      instance_id: "inst-1",
      machine: "remote",
    }));
    const report = compareCodecCards(remoteCapture, authority([row()]), NOW);
    expect(report.summary).toEqual({ checked: 0, mismatches: 1, unverified: 1 });
    expect(report.findings).toContainEqual(expect.objectContaining({ field: "card", known: "active" }));
  });

  test("detects a task that was authoritatively cleared", () => {
    const report = compareCodecCards(
      capture(),
      authority([row({ task: null, task_updated_at: NOW })]),
      NOW,
    );
    expect(report.findings).toMatchObject([{ field: "task", card: "Build Codec", known: null }]);
  });

  test("detects a V3 task clear after its cache timestamp was removed", () => {
    const cleared = {
      ...row({ task: undefined, task_updated_at: null }),
      v3_task_state: "cleared",
    };
    const report = compareCodecCards(capture(), authority([cleared]), NOW);
    expect(report.findings).toMatchObject([{ field: "task", card: "Build Codec", known: null }]);
  });

  test("compares the trimmed task label the projector displays", () => {
    const report = compareCodecCards(capture(), authority([row({ task: "  Build Codec  " })]), NOW);
    expect(report.findings).toEqual([]);
  });

  test("does not mistake a missing task label for an authoritative clear", () => {
    const report = compareCodecCards(
      capture(),
      authority([row({ task: undefined, task_updated_at: null })]),
      NOW,
    );
    expect(report.findings).toEqual([]);
  });

  test("matches a local card keyed by the canonical alias", () => {
    const canonical = capture();
    canonical.cards[0]!.instance_id = "inst-1";
    expect(compareCodecCards(canonical, authority([row()]), NOW).findings).toEqual([]);
  });
});
