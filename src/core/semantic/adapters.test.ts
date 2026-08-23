import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSemanticHarnessOutput } from "./adapters.ts";

const FIXTURES = join(import.meta.dir, "../../../tests/fixtures/semantic");

describe("semantic harness usage parsing", () => {
  test("reads Claude native usage and model attestation without treating estimated cost as native", () => {
    const parsed = parseSemanticHarnessOutput(
      "claude-code",
      readFileSync(join(FIXTURES, "claude-result.json"), "utf8"),
    );

    expect(JSON.parse(parsed.text)).toEqual({ schema_version: 2, fixture: true });
    expect(parsed.executedModelId).toBe("claude-haiku-4-5-20251001");
    expect(parsed.usage).toEqual({
      schema_version: 1,
      source: "native",
      scope: "harness-call",
      tokens: {
        input_tokens: { value: 41, provenance: "native" },
        cached_input_tokens: { value: 3400, provenance: "native" },
        cache_creation_input_tokens: { value: 1200, provenance: "native" },
        output_tokens: { value: 87, provenance: "native" },
      },
    });
    expect(JSON.stringify(parsed.usage)).not.toContain("cost");
  });

  test("reads Codex JSONL usage while retaining the structured final response", () => {
    const finalResponse = '{"schema_version":2,"fixture":"from-output-file"}';
    const parsed = parseSemanticHarnessOutput(
      "codex",
      readFileSync(join(FIXTURES, "codex-events.jsonl"), "utf8"),
      finalResponse,
    );

    expect(parsed.text).toBe(finalResponse);
    expect(parsed.executedModelId).toBeUndefined();
    expect(parsed.usage).toMatchObject({
      source: "native",
      tokens: {
        input_tokens: { value: 5100, provenance: "native" },
        cached_input_tokens: { value: 4096, provenance: "native" },
        cache_creation_input_tokens: { value: 512, provenance: "native" },
        output_tokens: { value: 233, provenance: "native" },
        reasoning_tokens: { value: 144, provenance: "native" },
      },
    });
  });

  test("reads Cursor terminal usage and the stream init model", () => {
    const parsed = parseSemanticHarnessOutput(
      "cursor",
      readFileSync(join(FIXTURES, "cursor-events.jsonl"), "utf8"),
    );

    expect(parsed.text).toBe('{"schema_version":2,"fixture":true}');
    expect(parsed.executedModelId).toBe("Composer 2.5");
    expect(parsed.usage).toMatchObject({
      source: "native",
      tokens: {
        input_tokens: { value: 73, provenance: "native" },
        cached_input_tokens: { value: 2048, provenance: "native" },
        cache_creation_input_tokens: { value: 1024, provenance: "native" },
        output_tokens: { value: 29, provenance: "native" },
      },
    });
  });
});
