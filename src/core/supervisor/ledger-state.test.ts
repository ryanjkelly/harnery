import { describe, expect, test } from "bun:test";
import { SUPERVISOR_DIAGNOSTIC_LIMITS, type SupervisorCapability } from "./contract.ts";
import {
  type LedgerControlStateObservationV1,
  ledgerControlStateFindingCandidateV1,
} from "./ledger-state.ts";

const capability: SupervisorCapability = { source_kind: "coordination.v3", state: "supported" };

describe("event ledger control-state finding", () => {
  test("an active control state opens nothing", () => {
    expect(
      ledgerControlStateFindingCandidateV1({
        current: observation("active", "2026-09-02T09:57:44.000Z"),
        previous: [observation("active", "2026-09-02T09:57:42.000Z")],
        capability,
      }),
    ).toBeUndefined();
  });

  test("one non-active observation is a boundary, not drift", () => {
    expect(
      ledgerControlStateFindingCandidateV1({
        current: observation("candidate", "2026-09-02T09:57:44.000Z"),
        capability,
      }),
    ).toBeUndefined();
    expect(
      ledgerControlStateFindingCandidateV1({
        current: observation("candidate", "2026-09-02T09:57:44.000Z"),
        previous: [observation("active", "2026-09-02T09:57:42.000Z")],
        capability,
      }),
    ).toBeUndefined();
  });

  test("drift past one history point opens a diagnostic finding", () => {
    const finding = ledgerControlStateFindingCandidateV1({
      current: observation("candidate", "2026-09-02T09:57:44.000Z"),
      previous: [observation("candidate", "2026-09-02T09:57:42.000Z")],
      capability,
    });

    expect(finding).toBeDefined();
    expect(finding).toMatchObject({
      source_kind: "coordination.v3",
      finding_kind: "coordination.ledger-diagnostic",
      finding_class: "diagnostic",
      severity: "warning",
      scope_kind: "ledger",
      scope_id: "control-state:candidate",
    });
    expect(finding?.summary).toContain("candidate");
    expect(finding?.summary).toContain("2026-09-02T09:57:42.000Z");
    expect(finding?.summary.length).toBeLessThanOrEqual(
      SUPERVISOR_DIAGNOSTIC_LIMITS.max_summary_chars,
    );
    expect(finding?.evidence).toHaveLength(1);
    expect(finding?.evidence[0]).toMatchObject({ observed_value: 2, unit: "count" });
    expect(finding?.capabilities).toEqual([capability]);
    expect(finding?.primary_source).toMatchObject({
      source_kind: "coordination.v3",
      source_id: "control-state:candidate",
      observed_at: "2026-09-02T09:57:44.000Z",
      capability: "supported",
    });
  });

  test("an unreadable control pair is critical and names its reason", () => {
    const finding = ledgerControlStateFindingCandidateV1({
      current: {
        state: "invalid",
        reason: "ledger_integrity_failure",
        observed_at: "2026-09-02T09:57:44.000Z",
      },
      previous: [
        {
          state: "invalid",
          reason: "ledger_integrity_failure",
          observed_at: "2026-09-02T09:57:42.000Z",
        },
      ],
      capability,
    });

    expect(finding).toMatchObject({
      severity: "critical",
      scope_id: "control-state:invalid",
      finding_class: "diagnostic",
    });
    expect(finding?.summary).toContain("ledger_integrity_failure");
    expect(finding?.primary_source.source_id).toBe(
      "control-state:invalid:ledger_integrity_failure",
    );
  });

  test("counts only the drift that has run without interruption", () => {
    const finding = ledgerControlStateFindingCandidateV1({
      current: observation("candidate", "2026-09-02T09:57:48.000Z"),
      previous: [
        observation("candidate", "2026-09-02T09:57:46.000Z"),
        observation("candidate", "2026-09-02T09:57:44.000Z"),
        observation("active", "2026-09-02T09:57:42.000Z"),
        observation("candidate", "2026-09-02T09:57:40.000Z"),
      ],
      capability,
    });

    expect(finding?.evidence[0]?.observed_value).toBe(3);
    expect(finding?.summary).toContain("2026-09-02T09:57:44.000Z");
  });

  test("identical observations produce an identical candidate", () => {
    const input = {
      current: observation("repairable", "2026-09-02T09:57:44.000Z"),
      previous: [observation("repairable", "2026-09-02T09:57:42.000Z")],
      capability,
    };

    expect(ledgerControlStateFindingCandidateV1(input)).toEqual(
      ledgerControlStateFindingCandidateV1(input),
    );
  });

  test("a partial observation capability travels with the finding", () => {
    const partial: SupervisorCapability = {
      source_kind: "coordination.v3",
      state: "partial",
      reason_code: "ledger_unreadable",
    };
    const finding = ledgerControlStateFindingCandidateV1({
      current: observation("closed", "2026-09-02T09:57:44.000Z"),
      previous: [observation("closed", "2026-09-02T09:57:42.000Z")],
      capability: partial,
    });

    expect(finding?.severity).toBe("critical");
    expect(finding?.primary_source.capability).toBe("partial");
    expect(finding?.capabilities).toEqual([partial]);
  });
});

function observation(
  state: LedgerControlStateObservationV1["state"],
  observedAt: string,
): LedgerControlStateObservationV1 {
  return { state, observed_at: observedAt };
}
