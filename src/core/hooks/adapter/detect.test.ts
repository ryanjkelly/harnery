import { afterEach, describe, expect, test } from "bun:test";

import { detectAdapter, isCursorRuntime, shouldSkipHookAdapter } from "./detect.ts";

const originalAdapter = process.env.HARNERY_AGENT_COORD_ADAPTER;

afterEach(() => {
  restoreEnv("HARNERY_AGENT_COORD_ADAPTER", originalAdapter);
});

describe("detectAdapter", () => {
  test("reads the current adapter flag forms", () => {
    expect(detectAdapter(["session-start", "--adapter", "codex"])).toBe("codex");
    expect(detectAdapter(["session-start", "--adapter=cursor"])).toBe("cursor");
  });
});

describe("isCursorRuntime", () => {
  test('true only when CURSOR_AGENT is exactly "1"', () => {
    expect(isCursorRuntime({ CURSOR_AGENT: "1" })).toBeTrue();
    expect(isCursorRuntime({ CURSOR_AGENT: "true" })).toBeFalse();
    expect(isCursorRuntime({ CURSOR_AGENT: "" })).toBeFalse();
    expect(isCursorRuntime({})).toBeFalse();
  });
});

describe("shouldSkipHookAdapter", () => {
  test("skips only a claude-code dispatch under a Cursor runtime", () => {
    const cursorEnv = { CURSOR_AGENT: "1" };
    expect(shouldSkipHookAdapter("claude-code", cursorEnv)).toBeTrue();
    expect(shouldSkipHookAdapter("cursor", cursorEnv)).toBeFalse();
    expect(shouldSkipHookAdapter("codex", cursorEnv)).toBeFalse();
    expect(shouldSkipHookAdapter(null, cursorEnv)).toBeFalse();
    expect(shouldSkipHookAdapter("claude-code", {})).toBeFalse();
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
