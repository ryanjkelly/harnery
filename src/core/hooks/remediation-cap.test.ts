import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  clearRemediationCount,
  DEFAULT_STOP_REMEDIATION_CAP,
  remediationCapExceeded,
} from "./remediation-cap.ts";

describe("remediationCapExceeded", () => {
  test("a fresh stop cycle never exceeds the cap", () => {
    const sid = randomUUID();
    expect(remediationCapExceeded(sid, false)).toBe(false);
    clearRemediationCount(sid);
  });

  test("continuations exceed the cap only after `cap` blocked stops", () => {
    const sid = randomUUID();
    expect(remediationCapExceeded(sid, false)).toBe(false); // block 1: fresh cycle
    for (let block = 2; block <= DEFAULT_STOP_REMEDIATION_CAP; block += 1) {
      expect(remediationCapExceeded(sid, true)).toBe(false);
    }
    expect(remediationCapExceeded(sid, true)).toBe(true); // block cap+1: exhausted
    clearRemediationCount(sid);
  });

  test("a stop without the continuation flag resets the cycle", () => {
    const sid = randomUUID();
    for (let block = 0; block < DEFAULT_STOP_REMEDIATION_CAP + 2; block += 1) {
      remediationCapExceeded(sid, block > 0);
    }
    expect(remediationCapExceeded(sid, true)).toBe(true);
    expect(remediationCapExceeded(sid, false)).toBe(false); // fresh cycle
    expect(remediationCapExceeded(sid, true)).toBe(false); // count restarted at 1
    clearRemediationCount(sid);
  });

  test("clearRemediationCount resets an exhausted cycle", () => {
    const sid = randomUUID();
    for (let block = 0; block <= DEFAULT_STOP_REMEDIATION_CAP; block += 1) {
      remediationCapExceeded(sid, block > 0);
    }
    expect(remediationCapExceeded(sid, true)).toBe(true);
    clearRemediationCount(sid);
    expect(remediationCapExceeded(sid, true)).toBe(false); // no prior file → count 1
    clearRemediationCount(sid);
  });

  test("an empty session id is usable (keyed as default)", () => {
    expect(remediationCapExceeded("", false)).toBe(false);
    clearRemediationCount("");
  });
});
