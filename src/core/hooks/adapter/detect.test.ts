import { afterEach, describe, expect, test } from "bun:test";

import { detectAdapter } from "./detect.ts";

const originalAdapter = process.env.HARNERY_AGENT_COORD_ADAPTER;
const originalHarness = process.env.HARNERY_AGENT_COORD_HARNESS;

afterEach(() => {
  restoreEnv("HARNERY_AGENT_COORD_ADAPTER", originalAdapter);
  restoreEnv("HARNERY_AGENT_COORD_HARNESS", originalHarness);
});

describe("detectAdapter", () => {
  test("reads the current adapter flag forms", () => {
    expect(detectAdapter(["session-start", "--adapter", "codex"])).toBe("codex");
    expect(detectAdapter(["session-start", "--adapter=cursor"])).toBe("cursor");
  });

  test("keeps pre-rename harness flags working after a package upgrade", () => {
    expect(detectAdapter(["session-start", "--harness", "codex"])).toBe("codex");
    expect(detectAdapter(["session-start", "--harness=claude_code"])).toBe("claude-code");
  });

  test("falls back to the legacy environment variable", () => {
    delete process.env.HARNERY_AGENT_COORD_ADAPTER;
    process.env.HARNERY_AGENT_COORD_HARNESS = "cursor";

    expect(detectAdapter(["session-start"])).toBe("cursor");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
