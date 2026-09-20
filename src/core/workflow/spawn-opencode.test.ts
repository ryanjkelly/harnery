import { describe, expect, test } from "bun:test";
import { parseOpenCodeStream } from "./spawn-opencode.ts";

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
