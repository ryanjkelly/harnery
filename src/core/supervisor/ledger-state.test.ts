import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { readEventV3ControlState } from "../events/v3/control.ts";
import { SUPERVISOR_DIAGNOSTIC_LIMITS, type SupervisorCapability } from "./contract.ts";
import {
  type LedgerControlStateObservationV1,
  ledgerControlStateFindingCandidateV1,
  observeLedgerControlState,
} from "./ledger-state.ts";

const capability: SupervisorCapability = { source_kind: "coordination.v3", state: "supported" };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

  test("an incompatible observer reports its capability without asserting a writer outage", () => {
    const incompatible: LedgerControlStateObservationV1 = {
      state: "invalid",
      reason: "genesis_schema_digest_incompatible",
      observed_at: "2026-11-05T20:59:00.000Z",
    };
    const finding = ledgerControlStateFindingCandidateV1({
      current: incompatible,
      previous: [{ ...incompatible, observed_at: "2026-11-05T20:58:58.000Z" }],
      capability: {
        source_kind: "event-ledger.control-state",
        state: "unsupported",
        reason_code: "schema-digest-incompatible",
      },
    });

    expect(finding?.severity).toBe("warning");
    expect(finding?.summary).toContain("cannot validate");
    expect(finding?.summary).toContain("unverified");
    expect(finding?.summary).not.toContain("Writes are gated");
    expect(finding?.primary_source.capability).toBe("unsupported");
    expect(finding?.scope_id).toBe("control-reader:schema-incompatible");
  });

  test("an older loaded schema cannot invalidate the installed build's active authority", () => {
    const root = mkdtempSync(join(tmpdir(), "harn-supervisor-schema-"));
    roots.push(root);
    initializeEventLedgerV3({
      coordRoot: root,
      hostBuild: "host-fixture",
      harneryBuild: "installed-build",
      configDigest: `sha256:${"b".repeat(64)}`,
      approvalRecordId: "test-supervisor-observer",
      now: () => new Date("2026-11-05T20:58:00.000Z"),
    });
    const activePath = join(root, ".harnery/ledgers/v3/active.ndjson");
    const genesisPath = join(root, ".harnery/ledgers/v3/genesis.json");
    const before = [readFileSync(activePath, "utf8"), readFileSync(genesisPath, "utf8")];
    expect(observeLedgerControlState(root, new Date()).observation.state).toBe("active");

    // A separate process pins a prior loaded schema while reading the same
    // valid installation. It cannot alter this process's module cache.
    const staleObserver = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        String.raw`
          import { plugin } from "bun";
          import { readFileSync } from "node:fs";
          plugin({
            name: "prior-loaded-schema",
            setup(build) {
              build.onLoad({ filter: /generated[.]ts$/ }, ({ path }) => ({
                contents: readFileSync(path, "utf8").replace(
                  /export const EVENT_V3_SCHEMA_DIGEST =\s*"sha256:[a-f0-9]+"/,
                  'export const EVENT_V3_SCHEMA_DIGEST = "sha256:${"a".repeat(64)}"',
                ),
                loader: "ts",
              }));
            },
          });
          const { observeLedgerControlState } = await import(${JSON.stringify(join(import.meta.dir, "ledger-state.ts"))});
          console.log(JSON.stringify(observeLedgerControlState(${JSON.stringify(root)}, new Date("2026-11-05T20:59:00.000Z"))));
        `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(staleObserver.exitCode).toBe(0);
    const stale = JSON.parse(staleObserver.stdout.toString());
    expect(stale).toMatchObject({
      observation: { state: "invalid", reason: "genesis_schema_digest_incompatible" },
      capability: { state: "unsupported", reason_code: "schema-digest-incompatible" },
    });
    expect(readEventV3ControlState(root).state).toBe("active");
    expect([readFileSync(activePath, "utf8"), readFileSync(genesisPath, "utf8")]).toEqual(before);
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
