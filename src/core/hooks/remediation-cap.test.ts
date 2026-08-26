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
