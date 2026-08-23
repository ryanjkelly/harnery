import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStopRemediationExhaustions } from "./agents.ts";

describe("readStopRemediationExhaustions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-stop-remediation-"));
    mkdirSync(path.join(root, ".harnery", "debug"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeDebugLedger(lines: Array<Record<string, unknown>>): void {
    writeFileSync(
      path.join(root, ".harnery", "debug", "agent-hook.ndjson"),
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }

  test("missing ledger reports zero", () => {
    expect(readStopRemediationExhaustions(root, 0)).toEqual({
      total: 0,
      latestAt: null,
      sessions: [],
    });
  });

  test("counts exhaustions in the window and samples their sessions", () => {
    const inWindow = "2026-08-23T04:00:00.000Z";
    const later = "2026-08-23T05:00:00.000Z";
    writeDebugLedger([
      {
        ts: inWindow,
        event_name: "stop",
        skipped: "stop-remediation-cap-exhausted",
        session_id: "sess-a",
      },
      {
        ts: later,
        event_name: "stop",
        skipped: "stop-remediation-cap-exhausted",
        session_id: "sess-b",
      },
      // Ordinary stop rows and other skip reasons are not exhaustions.
      { ts: later, event_name: "stop", event_v3_state: "recorded" },
      { ts: later, event_name: "stop", skipped: "v3-control-blocked" },
    ]);
    const report = readStopRemediationExhaustions(root, Date.parse("2026-08-23T00:00:00.000Z"));
    expect(report.total).toBe(2);
    expect(report.latestAt).toBe(later);
    expect(report.sessions.sort()).toEqual(["sess-a", "sess-b"]);
  });

  test("rows before the cutoff are excluded", () => {
    writeDebugLedger([
      {
        ts: "2026-08-20T00:00:00.000Z",
        skipped: "stop-remediation-cap-exhausted",
        session_id: "sess-old",
      },
    ]);
    expect(readStopRemediationExhaustions(root, Date.parse("2026-08-22T00:00:00.000Z"))).toEqual({
      total: 0,
      latestAt: null,
      sessions: [],
    });
  });
});
