import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { assessCodexHookList, probeCodexHookAuthorization } from "./codex-authorization.ts";

const cwd = "/work/project";

function response(
  hooks: Array<{ command: string; enabled: boolean; trustStatus: string }>,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    id: 1,
    result: {
      data: [{ cwd, hooks, warnings: [], errors: [], ...overrides }],
    },
  };
}

describe("assessCodexHookList", () => {
  test("reports trusted and managed Harnery hooks as runnable", () => {
    const result = assessCodexHookList(
      response([
        {
          command: "bash harnery/bin/agent-hook session-start",
          enabled: true,
          trustStatus: "trusted",
        },
        { command: "bash harnery/bin/agent-hook stop", enabled: true, trustStatus: "managed" },
        { command: "python unrelated.py", enabled: true, trustStatus: "untrusted" },
      ]),
      cwd,
    );
    expect(result.status).toBe("runnable");
    expect(result.hookCount).toBe(2);
    expect(result.trustCounts).toEqual({ trusted: 1, managed: 1 });
  });

  test("requires review for new or modified commands", () => {
    const result = assessCodexHookList(
      response([
        {
          command: "bash harnery/bin/agent-hook session-start",
          enabled: true,
          trustStatus: "untrusted",
        },
        { command: "bash harnery/bin/agent-hook stop", enabled: true, trustStatus: "modified" },
      ]),
      cwd,
    );
    expect(result.status).toBe("review_required");
    expect(result.detail).toContain("1 new, 1 modified");
  });

  test("does not call trusted but disabled hooks runnable", () => {
    const result = assessCodexHookList(
      response([
        {
          command: "bash harnery/bin/agent-hook session-start",
          enabled: false,
          trustStatus: "trusted",
        },
      ]),
      cwd,
    );
    expect(result.status).toBe("disabled");
  });

  test("surfaces discovery errors", () => {
    const result = assessCodexHookList(response([], { errors: ["invalid hooks file"] }), cwd);
    expect(result.status).toBe("error");
    expect(result.detail).toContain("invalid hooks file");
  });
});

describe("probeCodexHookAuthorization", () => {
  const fixture = fileURLToPath(
    new URL("../../../tests/fixtures/fake-codex-app-server.mjs", import.meta.url),
  );
  const probeCwd = process.cwd();

  test("performs the initialize and hooks/list handshake", async () => {
    const result = await probeCodexHookAuthorization({
      cwd: probeCwd,
      codexBin: "bun",
      appServerArgs: [fixture],
      env: { ...process.env, FAKE_CODEX_TRUST_STATUS: "untrusted" },
    });
    expect(result.status).toBe("review_required");
    expect(result.hookCount).toBe(1);
  });

  test("times out without changing authorization", async () => {
    const result = await probeCodexHookAuthorization({
      cwd: probeCwd,
      codexBin: "bun",
      appServerArgs: [fixture],
      env: { ...process.env, FAKE_CODEX_SILENT: "1" },
      timeoutMs: 25,
    });
    expect(result.status).toBe("error");
    expect(result.detail).toContain("timed out");
  });
});
