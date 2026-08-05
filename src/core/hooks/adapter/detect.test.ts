import { afterEach, describe, expect, test } from "bun:test";

import { detectAdapter } from "./detect.ts";

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

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
