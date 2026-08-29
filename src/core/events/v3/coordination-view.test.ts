import { describe, expect, test } from "bun:test";

import { projectCoordinationViewV3 } from "./coordination-view.ts";
import type { ReadLedgerV3Result } from "./reader.ts";

function emptyLedger(): ReadLedgerV3Result {
  return {
    events: [],
    diagnostics: [],
    complete: true,
    advances: [],
    bytes: 0,
  };
}

describe("coordination view projection cache", () => {
  test("reuses a projection for the same immutable ledger snapshot", () => {
    const ledger = emptyLedger();
    expect(projectCoordinationViewV3(ledger)).toBe(projectCoordinationViewV3(ledger));
  });

  test("builds a fresh projection for a new ledger snapshot", () => {
    const first = emptyLedger();
    const second = emptyLedger();
    expect(projectCoordinationViewV3(first)).not.toBe(projectCoordinationViewV3(second));
  });
});
