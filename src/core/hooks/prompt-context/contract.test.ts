import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PROMPT_CONTEXT_MAX_OUTPUT_BYTES,
  DEFAULT_PROMPT_CONTEXT_TIMEOUT_MS,
  parsePromptContextConfig,
  promptContextDelivery,
  validatePromptContextResult,
} from "./contract.ts";

describe("prompt-context contract", () => {
  test("pins adapter delivery modes", () => {
    expect(promptContextDelivery("claude-code")).toBe("direct");
    expect(promptContextDelivery("codex")).toBe("direct");
    expect(promptContextDelivery("cursor")).toBe("consume");
  });

  test("defaults off and accepts bounded enabled config", () => {
    expect(parsePromptContextConfig(undefined)).toEqual({
      enabled: false,
      timeoutMs: DEFAULT_PROMPT_CONTEXT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_PROMPT_CONTEXT_MAX_OUTPUT_BYTES,
    });
    expect(
      parsePromptContextConfig({ enabled: true, timeoutMs: 2_000, maxOutputBytes: 4_096 }),
    ).toEqual({
      enabled: true,
      timeoutMs: 2_000,
      maxOutputBytes: 4_096,
    });
  });

  test("rejects malformed or out-of-range config", () => {
    expect(parsePromptContextConfig({ enabled: "yes" })).toBeNull();
    expect(parsePromptContextConfig({ enabled: true, timeoutMs: 0 })).toBeNull();
    expect(
      parsePromptContextConfig({ enabled: true, maxOutputBytes: 4 * 1024 * 1024 + 1 }),
    ).toBeNull();
  });

  test("accepts every shared v1 result fixture", () => {
    const path = join(import.meta.dir, "../../../../tests/fixtures/prompt-context/v1.json");
    const fixtures = JSON.parse(readFileSync(path, "utf8")) as Array<{ result: unknown }>;
    expect(fixtures.length).toBe(5);
    for (const fixture of fixtures)
      expect(validatePromptContextResult(fixture.result).ok).toBeTrue();
  });

  test("rejects inconsistent counts and unsafe identifiers", () => {
    expect(
      validatePromptContextResult({
        schema: "harnery.prompt-context-result/v1",
        provider_id: "provider one",
        context: "",
        matched: 0,
        succeeded: 0,
        failed: 0,
        reason_codes: [],
      }),
    ).toEqual({ ok: false, reason: "invalid_provider_id" });
    expect(
      validatePromptContextResult({
        schema: "harnery.prompt-context-result/v1",
        provider_id: "provider-one",
        context: "<record />",
        matched: 2,
        succeeded: 1,
        failed: 0,
        reason_codes: ["record_id"],
      }),
    ).toEqual({ ok: false, reason: "count_mismatch" });
  });
});
