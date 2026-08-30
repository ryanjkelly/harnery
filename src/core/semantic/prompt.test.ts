import { describe, expect, test } from "bun:test";
import { extractSemanticJson } from "./prompt.ts";

describe("semantic JSON extraction", () => {
  test("reads bare, fenced, and outer-object model replies", () => {
    expect(extractSemanticJson('{"kind":"bare"}')).toEqual({ kind: "bare" });
    expect(extractSemanticJson('prose\n```JSON\n{"kind":"fenced"}\n```\nmore')).toEqual({
      kind: "fenced",
    });
    expect(extractSemanticJson('prefix {"kind":"outer"} suffix')).toEqual({ kind: "outer" });
  });

  test("scans long fenced whitespace without a backtracking regular expression", () => {
    const reply = `\`\`\`json${" ".repeat(250_000)}{"ok":true}\n\`\`\``;
    expect(extractSemanticJson(reply)).toEqual({ ok: true });
  });

  test("returns undefined when no complete JSON object is present", () => {
    expect(extractSemanticJson("```json\n{broken\n```")).toBeUndefined();
    expect(extractSemanticJson("no object here")).toBeUndefined();
  });
});
