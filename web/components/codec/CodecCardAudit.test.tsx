import { expect, test } from "bun:test";

import type { CodecCardAuditReport } from "@/lib/codec/card-audit";

import { codecCardAuditHistory, isCodecCardAuditReport } from "./CodecCardAudit";

function report(index = 0): CodecCardAuditReport {
  const timestamp = new Date(Date.UTC(2026, 9, 26, 18, 0, index)).toISOString();
  return {
    capture: {
      captured_at: timestamp,
      scene_generated_at: timestamp,
      cards: [{
        instance_id: "session-1",
        display_name: "Ada",
        task: null,
        presence: "online",
        activity: "working",
        lifecycle: "active",
        ledger_state: "live",
        updated_at: timestamp,
      }],
    },
    checked_at: timestamp,
    authority_read_state: { ok: true },
    findings: [],
    summary: { checked: 1, mismatches: 0, unverified: 0 },
  };
}

test("saved audit history drops malformed entries before rendering and keeps valid order", () => {
  const first = report(1);
  const second = report(2);
  expect(codecCardAuditHistory([null, {}, first, { capture: {} }, second])).toEqual([first, second]);
  for (const value of [null, {}, "saved report", 1]) {
    expect(codecCardAuditHistory(value)).toEqual([]);
  }
});

test("the ten-report limit applies after malformed history entries are removed", () => {
  const reports = Array.from({ length: 12 }, (_, index) => report(index));
  expect(codecCardAuditHistory([{}, ...reports])).toEqual(reports.slice(0, 10));
});

test("nested audit data required by the report controls must be valid", () => {
  const valid = report();
  const invalid: unknown[] = [
    { ...valid, capture: { ...valid.capture, captured_at: "not-a-date" } },
    { ...valid, capture: { ...valid.capture, cards: [null] } },
    { ...valid, capture: { ...valid.capture, cards: [{ ...valid.capture.cards[0], task: {} }] } },
    { ...valid, authority_read_state: { ok: false } },
    { ...valid, summary: { checked: -1, mismatches: 0, unverified: 0 } },
    { ...valid, summary: { checked: 1, mismatches: Number.NaN, unverified: 0 } },
    { ...valid, findings: [{ display_name: "Ada" }] },
  ];
  expect(isCodecCardAuditReport(valid)).toBe(true);
  for (const value of invalid) expect(isCodecCardAuditReport(value)).toBe(false);
});

test("unverified and remote audit reports remain available in saved history", () => {
  const unverified = report();
  unverified.capture.cards[0]!.machine = "remote";
  unverified.authority_read_state = { ok: false, reason: "ledger unavailable" };
  unverified.findings = [{
    instance_id: "session-1",
    display_name: "Ada",
    field: "authority",
    card: null,
    known: null,
    explanation: "Remote cards must be compared on their source machine.",
    severity: "unverified",
  }];
  unverified.summary = { checked: 0, mismatches: 0, unverified: 1 };
  expect(codecCardAuditHistory([unverified])).toEqual([unverified]);
});
