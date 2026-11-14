import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  clearRemediationCount,
  DEFAULT_STOP_REMEDIATION_CAP,
  recordRemediationBlock,
} from "./remediation-cap.ts";

describe("recordRemediationBlock", () => {
  test("a fresh stop cycle never exceeds the cap", () => {
    const sid = randomUUID();
    expect(recordRemediationBlock(sid, false)).toEqual({ count: 1, exceeded: false });
    clearRemediationCount(sid);
  });

  test("continuations exceed the cap only after `cap` blocked stops", () => {
    const sid = randomUUID();
    expect(recordRemediationBlock(sid, false)).toEqual({ count: 1, exceeded: false });
    for (let block = 2; block <= DEFAULT_STOP_REMEDIATION_CAP; block += 1) {
      expect(recordRemediationBlock(sid, true)).toEqual({ count: block, exceeded: false });
    }
    expect(recordRemediationBlock(sid, true)).toEqual({
      count: DEFAULT_STOP_REMEDIATION_CAP + 1,
      exceeded: true,
    });
    clearRemediationCount(sid);
  });

  test("a stop without the continuation flag resets the cycle", () => {
    const sid = randomUUID();
    for (let block = 0; block < DEFAULT_STOP_REMEDIATION_CAP + 2; block += 1) {
      recordRemediationBlock(sid, block > 0);
    }
    expect(recordRemediationBlock(sid, true).exceeded).toBe(true);
    expect(recordRemediationBlock(sid, false)).toEqual({ count: 1, exceeded: false });
    expect(recordRemediationBlock(sid, true)).toEqual({ count: 2, exceeded: false });
    clearRemediationCount(sid);
  });

  test("clearRemediationCount resets an exhausted cycle", () => {
    const sid = randomUUID();
    for (let block = 0; block <= DEFAULT_STOP_REMEDIATION_CAP; block += 1) {
      recordRemediationBlock(sid, block > 0);
    }
    expect(recordRemediationBlock(sid, true).exceeded).toBe(true);
    clearRemediationCount(sid);
    expect(recordRemediationBlock(sid, true)).toEqual({ count: 2, exceeded: false });
    clearRemediationCount(sid);
  });

  test("an empty session id is usable (keyed as default)", () => {
    expect(recordRemediationBlock("", false)).toEqual({ count: 1, exceeded: false });
    clearRemediationCount("");
  });
});

describe("stop cap exhaustion cue", () => {
  test("a recorded exhaustion is taken once and then cleared", async () => {
    const { recordStopCapExhaustion, takeStopCapExhaustion } = await import("./remediation-cap.ts");
    const sid = randomUUID();
    expect(takeStopCapExhaustion(sid)).toBeNull();
    recordStopCapExhaustion(sid, {
      rule: "stop-hook.status_missing",
      reason: "Owned work is not finalized.\nmore detail",
      blocked_count: 5,
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(takeStopCapExhaustion(sid)).toEqual({
      rule: "stop-hook.status_missing",
      reason: "Owned work is not finalized.\nmore detail",
      blocked_count: 5,
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(takeStopCapExhaustion(sid)).toBeNull();
  });

  test("notice and cue name the rule, the fix, and the report to the operator", async () => {
    const { formatStopCapCue, formatStopCapNotice } = await import("./remediation-cap.ts");
    const exhaustion = {
      rule: "stop-hook.status_missing",
      reason: "Owned work is not finalized.\nmore detail",
      blocked_count: 5,
      at: "",
    };
    const notice = formatStopCapNotice(exhaustion);
    expect(notice).toContain("5 blocked attempts");
    expect(notice).toContain("stop-hook.status_missing");
    expect(notice).not.toContain("\n");
    const cue = formatStopCapCue(exhaustion, "harn agents status --end-turn");
    expect(cue).toContain("rule stop-hook.status_missing");
    expect(cue).toContain("What was unmet: Owned work is not finalized.");
    expect(cue).not.toContain("more detail");
    expect(cue).toContain("`harn agents status --end-turn`");
    expect(cue).toContain("tell the operator in one plain sentence");
  });
});
