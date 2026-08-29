import { describe, expect, test } from "bun:test";
import {
  classifyEventV3Support,
  EVENT_V3_DIAGNOSTIC_CONSUMER_WINDOW_MS,
  EVENT_V3_DIAGNOSTIC_FIXED_GRACE_MS,
} from "./classify.ts";
import {
  assessEventV3AuthorityPackingGate,
  type EventV3AuthorityPackingCandidate,
  planEventV3ArchiveCanary,
} from "./eligibility.ts";

describe("Event Ledger V3 support classifier", () => {
  test("derives the diagnostic boundary from the consumer window plus fixed grace", () => {
    const now = "2026-08-29T00:00:00.000Z";
    const eligibleAt = new Date(
      Date.parse(now) - EVENT_V3_DIAGNOSTIC_CONSUMER_WINDOW_MS - EVENT_V3_DIAGNOSTIC_FIXED_GRACE_MS,
    ).toISOString();
    expect(
      classifyEventV3Support({
        family: "diagnostic",
        authority_state: "archived",
        epoch_maintenance_enabled: true,
        recorded_at: eligibleAt,
        filename_recorded_at: eligibleAt,
        now,
      }),
    ).toEqual({
      disposition: "pack-eligible",
      reasons: ["diagnostic_consumer_window_elapsed"],
    });
    const recent = "2026-08-28T23:00:00.000Z";
    expect(
      classifyEventV3Support({
        family: "diagnostic",
        authority_state: "active",
        epoch_maintenance_enabled: true,
        recorded_at: recent,
        filename_recorded_at: recent,
        now,
      }).reasons,
    ).toEqual(["diagnostic_within_loose_window"]);
  });

  test("returns exact fail-closed reasons for ambiguous and recovery-bearing state", () => {
    expect(
      classifyEventV3Support({
        family: "diagnostic",
        authority_state: "archived",
        epoch_maintenance_enabled: true,
        recorded_at: "2026-08-20T00:00:00.000Z",
        filename_recorded_at: "2026-08-20T00:00:02.000Z",
        now: "2026-08-29T00:00:00.000Z",
      }),
    ).toEqual({ disposition: "quarantine", reasons: ["diagnostic_timestamp_mismatch"] });
    expect(
      classifyEventV3Support({
        family: "session-tee",
        authority_state: "archived",
        epoch_maintenance_enabled: true,
        terminal: true,
        pending: true,
        now: "2026-08-29T00:00:00.000Z",
      }),
    ).toEqual({ disposition: "recovery-required", reasons: ["command_state_pending"] });
    expect(
      classifyEventV3Support({
        family: "authority-committed",
        authority_state: "archived",
        epoch_maintenance_enabled: true,
        producer_pending_reference: true,
        now: "2026-08-29T00:00:00.000Z",
      }).reasons,
    ).toEqual(["producer_pending_reference"]);
    expect(
      classifyEventV3Support({
        family: "authority-ready",
        authority_state: "active",
        epoch_maintenance_enabled: true,
        now: "2026-08-29T00:00:00.000Z",
      }).reasons,
    ).toEqual(["authority_ready_active"]);
  });

  test("keeps active command state and committed receipts disabled", () => {
    expect(
      classifyEventV3Support({
        family: "session-tee",
        authority_state: "active",
        epoch_maintenance_enabled: true,
        now: "2026-08-29T00:00:00.000Z",
      }).reasons,
    ).toEqual(["active_epoch_family_not_enabled"]);
    expect(
      classifyEventV3Support({
        family: "authority-committed",
        authority_state: "active",
        epoch_maintenance_enabled: true,
        now: "2026-08-29T00:00:00.000Z",
      }).reasons,
    ).toEqual(["active_committed_receipt_deferred"]);
  });

  test("selects only the smallest unbound archive canary", () => {
    const eligible = (path: string, files: number): EventV3AuthorityPackingCandidate => ({
      authority_root: path,
      state: "archived",
      genesis_id: `gen_${files}`,
      has_ready_transaction: false,
      has_pending_producer_state: false,
      has_maintenance_transaction: false,
      regular_file_count: files,
      entries: [
        {
          authority: { state: "archived" },
          family: "diagnostic",
          relative_path: "diagnostics/a.json",
          bytes: 1,
          digest: `sha256:${"0".repeat(64)}`,
          disposition: "pack-eligible",
          reasons: ["diagnostic_consumer_window_elapsed"],
          observed: { modified_at: "2026-08-20T00:00:00.000Z" },
        },
      ],
    });
    const protectedArchive = { ...eligible("protected", 1), recovery_receipt_id: "rcv_1" };
    expect(assessEventV3AuthorityPackingGate(protectedArchive)).toEqual({
      eligible: false,
      reasons: ["recovery_bound_archive_not_enabled"],
    });
    const plan = planEventV3ArchiveCanary([
      eligible("large", 10),
      protectedArchive,
      eligible("small", 2),
    ]);
    expect(plan.candidate?.authority_root).toBe("small");
    expect(plan.rejected).toEqual([
      { authority_root: "protected", reasons: ["recovery_bound_archive_not_enabled"] },
    ]);
  });
});
