import { describe, expect, test } from "bun:test";
import {
  buildOpenCodeInvocation,
  normalizeOpenCodeResult,
  parseOpenCodeStream,
} from "./spawn-opencode.ts";

test("a failed source-format stream retains text without asserting native effect or refusal", () => {
  const result = normalizeOpenCodeResult({
    stdout: JSON.stringify({
      type: "text",
      sessionID: "fixture-session",
      part: { type: "text", text: "Partial result" },
    }),
    stderr: "HTTP 429 Too Many Requests",
    exitCode: 1,
    durationMs: 1,
  });
  expect(result.text).toBe("Partial result");
  expect(result.sessionId).toBe("fixture-session");
  expect(result.failureEvidence?.effect.state).toBe("unknown");
  expect(result.failureEvidence?.refusal.state).toBe("unknown");
  expect(result.failureEvidence?.partial_output).toMatchObject({
    state: "present",
    source: "vendor_envelope",
  });
});

describe("parseOpenCodeStream", () => {
  test("joins text parts in order and takes the session id from any line", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", sessionID: "ses_abc", part: { type: "step-start" } }),
      "stray log line",
      JSON.stringify({
        type: "text",
        sessionID: "ses_abc",
        part: { type: "text", text: "Hello, " },
      }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_abc",
        part: { type: "tool", tool: "read" },
      }),
      JSON.stringify({
        type: "text",
        sessionID: "ses_abc",
        part: { type: "text", text: "world." },
      }),
      "",
    ].join("\n");
    expect(parseOpenCodeStream(stdout)).toEqual({ text: "Hello, world.", sessionId: "ses_abc" });
  });

  test("empty or non-JSON output yields empty text and no session id", () => {
    expect(parseOpenCodeStream("")).toEqual({ text: "", sessionId: undefined });
    expect(parseOpenCodeStream("not json\n{broken")).toEqual({ text: "", sessionId: undefined });
  });

  test("ignores a text part without a string body", () => {
    const stdout = JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text" } });
    expect(parseOpenCodeStream(stdout)).toEqual({ text: "", sessionId: "ses_1" });
  });
});

describe("buildOpenCodeInvocation", () => {
  const request = { prompt: "p", model: "provider/model", timeoutMs: 1, maxTurns: 1, cwd: "/tmp" };

  test("keeps the ordinary argv for a sandboxed request", () => {
    expect(buildOpenCodeInvocation(request).argv).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--auto",
      "--model",
      "provider/model",
      "p",
    ]);
  });

  test("refuses full access, which OpenCode cannot represent (ADR 0192)", () => {
    expect(() => buildOpenCodeInvocation({ ...request, access: "full-access" })).toThrow(
      /opencode declares no full-access mode/,
    );
  });
});
