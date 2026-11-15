import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import {
  clearRemediationCount,
  clearStopCapExhaustion,
  DEFAULT_STOP_REMEDIATION_CAP,
  formatStopCapCue,
  formatStopCapNotice,
  recordRemediationBlock,
  recordStopCapExhaustion,
  STOP_CAP_CUE_RETENTION_MS,
  type StopCapExhaustion,
  takeStopCapExhaustion,
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
  let root: string;
  const nowMs = Date.parse("2026-11-01T00:00:00.000Z");
  const exhaustion: StopCapExhaustion = {
    rule: "stop-hook.status_missing",
    reason: "Owned work is not finalized.\nmore detail",
    blocked_count: 5,
    at: new Date(nowMs).toISOString(),
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stop-cap-cue-"));
  });

  afterEach(() => removeDir(root));

  function cueFile(sessionId: string): string {
    const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
    return join(root, ".harnery", "active", "stop-cap-cues", `${key}.json`);
  }

  test("a recorded exhaustion is taken once and then cleared", () => {
    const sid = randomUUID();
    expect(takeStopCapExhaustion(root, sid, nowMs)).toBeNull();
    recordStopCapExhaustion(root, sid, exhaustion, nowMs);
    expect(existsSync(cueFile(sid))).toBe(true);
    expect(takeStopCapExhaustion(root, sid, nowMs)).toEqual(exhaustion);
    expect(existsSync(cueFile(sid))).toBe(false);
    expect(takeStopCapExhaustion(root, sid, nowMs)).toBeNull();
  });

  test("a temp-directory wipe loses the cycle counter but preserves the cue", () => {
    const sid = randomUUID();
    const temporaryDir = join(root, "os-temp");
    mkdirSync(temporaryDir);
    const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    try {
      for (const key of Object.keys(saved)) process.env[key] = temporaryDir;
      recordRemediationBlock(sid, false);
      expect(existsSync(join(tmpdir(), `harnery-stop-remediation-${sid}.count`))).toBe(true);
      recordStopCapExhaustion(root, sid, exhaustion, nowMs);
      rmSync(temporaryDir, { recursive: true });
      expect(takeStopCapExhaustion(root, sid, nowMs)).toEqual(exhaustion);
      expect(takeStopCapExhaustion(root, sid, nowMs)).toBeNull();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("project roots isolate cues with the same session id", () => {
    const sid = randomUUID();
    recordStopCapExhaustion(root, sid, exhaustion, nowMs);
    expect(takeStopCapExhaustion(join(root, "another-project"), sid, nowMs)).toBeNull();
    expect(takeStopCapExhaustion(root, sid, nowMs)).toEqual(exhaustion);
  });

  test("cues expire after three days and are deleted without delivery", () => {
    const sid = randomUUID();
    recordStopCapExhaustion(root, sid, exhaustion, nowMs);
    expect(takeStopCapExhaustion(root, sid, nowMs + STOP_CAP_CUE_RETENTION_MS - 1)).toEqual(
      exhaustion,
    );
    recordStopCapExhaustion(root, sid, exhaustion, nowMs);
    expect(takeStopCapExhaustion(root, sid, nowMs + STOP_CAP_CUE_RETENTION_MS)).toBeNull();
    expect(existsSync(cueFile(sid))).toBe(false);
  });

  test("a new cue prunes expired cues for sessions that never resumed", () => {
    const oldSession = randomUUID();
    const freshSession = randomUUID();
    recordStopCapExhaustion(root, oldSession, exhaustion, nowMs);
    const later = nowMs + STOP_CAP_CUE_RETENTION_MS;
    const fresh = { ...exhaustion, at: new Date(later).toISOString() };
    recordStopCapExhaustion(root, freshSession, fresh, later);
    expect(existsSync(cueFile(oldSession))).toBe(false);
    expect(takeStopCapExhaustion(root, freshSession, later)).toEqual(fresh);
  });

  test("session-end cleanup discards only the ending session's cue", () => {
    const ending = randomUUID();
    const other = randomUUID();
    recordStopCapExhaustion(root, ending, exhaustion, nowMs);
    recordStopCapExhaustion(root, other, exhaustion, nowMs);
    clearStopCapExhaustion(root, ending);
    expect(takeStopCapExhaustion(root, ending, nowMs)).toBeNull();
    expect(takeStopCapExhaustion(root, other, nowMs)).toEqual(exhaustion);
    expect(() => clearStopCapExhaustion(root, ending)).not.toThrow();
  });

  test.each([
    "{broken",
    "null",
    "[]",
    JSON.stringify({ ...exhaustion, rule: "" }),
    JSON.stringify({ ...exhaustion, at: "invalid" }),
    JSON.stringify({ ...exhaustion, at: undefined }),
    JSON.stringify({ ...exhaustion, blocked_count: "5" }),
    JSON.stringify({ ...exhaustion, at: new Date(nowMs + 1).toISOString() }),
  ])("a corrupt or invalid cue is ignored and removed: %s", (raw) => {
    const sid = randomUUID();
    const path = cueFile(sid);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, raw);
    expect(takeStopCapExhaustion(root, sid, nowMs)).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("read, write and cleanup failures never escape into the hook", () => {
    const blockedRoot = join(root, "file-instead-of-directory");
    writeFileSync(blockedRoot, "blocked");
    const sid = randomUUID();
    expect(() => recordStopCapExhaustion(blockedRoot, sid, exhaustion, nowMs)).not.toThrow();
    expect(takeStopCapExhaustion(blockedRoot, sid, nowMs)).toBeNull();
    expect(() => clearStopCapExhaustion(blockedRoot, sid)).not.toThrow();
    mkdirSync(cueFile(sid), { recursive: true });
    expect(takeStopCapExhaustion(root, sid, nowMs)).toBeNull();
    expect(() => clearStopCapExhaustion(root, sid)).not.toThrow();
  });

  test("notice and cue name the rule, the fix, and the report to the operator", () => {
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
