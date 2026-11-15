import { describe, expect, test } from "bun:test";
import { delegationKeyFromEnv, delegationKeyFromToolResult } from "./registry.ts";
import { T3_CODE_DELEGATION_SURFACE_ID } from "./surfaces/t3-code.ts";

const KEY =
  "thread:delegated-task:command%3Amcp%3A7f288e4d-3db9-4cfd-a43b-6332fcaabb2e%3Adelegate-task%3Aa20fbde0-c17a-450e-a5a0-18587b79c605";

/** The shape the client returns, trimmed to the fields that matter plus task text. */
function result(key = KEY): Record<string, unknown> {
  return {
    taskId: key.replace("thread:", "node:"),
    childThreadId: key,
    link: "[Do a private task](t3-thread://v2/x/y)",
    status: "running",
    summary: null,
  };
}

describe("T3 Code delegation surface", () => {
  test("reads the child key from every result shape the hooks deliver", () => {
    const shapes: unknown[] = [
      result(),
      JSON.stringify(result()),
      [{ type: "text", text: JSON.stringify(result()) }],
      { content: [{ type: "text", text: JSON.stringify(result()) }] },
    ];
    for (const shape of shapes) {
      expect(delegationKeyFromToolResult("mcp__t3-code__delegate_task", shape)).toEqual({
        surface: T3_CODE_DELEGATION_SURFACE_ID,
        key: KEY,
      });
    }
  });

  test("accepts the Codex tool spelling", () => {
    expect(delegationKeyFromToolResult("mcp__t3_code__delegate_task", result())?.key).toBe(KEY);
  });

  test("ignores other tools, malformed results and foreign ids", () => {
    expect(delegationKeyFromToolResult("mcp__t3-code__task_status", result())).toBeUndefined();
    expect(delegationKeyFromToolResult("Bash", result())).toBeUndefined();
    expect(delegationKeyFromToolResult(undefined, result())).toBeUndefined();
    for (const bad of [
      null,
      "not json",
      "{broken",
      { childThreadId: 42 },
      { childThreadId: "thread:ordinary-thread" },
      { childThreadId: `${KEY} plus words` },
      [
        { type: "text", text: JSON.stringify(result()) },
        { type: "text", text: JSON.stringify(result(`${KEY}0`)) },
      ],
    ]) {
      expect(delegationKeyFromToolResult("mcp__t3-code__delegate_task", bad)).toBeUndefined();
    }
  });

  test("reads the child key from a delegated child's environment only", () => {
    expect(delegationKeyFromEnv({ T3CODE_THREAD_ID: KEY }, "claude-code")?.key).toBe(KEY);
    expect(delegationKeyFromEnv({ T3CODE_THREAD_ID: KEY }, "codex")?.key).toBe(KEY);
    expect(delegationKeyFromEnv({ T3CODE_THREAD_ID: KEY }, "cursor")).toBeUndefined();
    expect(
      delegationKeyFromEnv(
        { T3CODE_THREAD_ID: "946f87f7-79bf-437b-8651-cc7fb936ab41" },
        "claude-code",
      ),
    ).toBeUndefined();
    expect(delegationKeyFromEnv({}, "claude-code")).toBeUndefined();
  });
});
