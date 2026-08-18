import { afterEach, describe, expect, test } from "bun:test";

import { detectAdapter, shouldSkipHookAdapter } from "./detect.ts";

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

describe("shouldSkipHookAdapter", () => {
  // Field-verified shapes: Cursor's dispatch envelope always carries a
  // top-level cursor_version; Claude Code payloads never do.
  const cursorPayload = JSON.stringify({
    conversation_id: "e5884c3c-42bc-4b85-be47-1600e3e182cb",
    session_id: "e5884c3c-42bc-4b85-be47-1600e3e182cb",
    hook_event_name: "sessionStart",
    model: "cursor-grok-4.5-high",
    cursor_version: "2026.08.11-e8db854",
    workspace_roots: ["/repo"],
    transcript_path: null,
  });
  const claudePayload = JSON.stringify({
    session_id: "29ef2739-72c2-4927-9181-8184743a7988",
    transcript_path: "/home/user/.claude/projects/repo/29ef2739.jsonl",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
  });

  test("skips only a claude-code dispatch carrying a Cursor payload", () => {
    expect(shouldSkipHookAdapter("claude-code", cursorPayload)).toBeTrue();
    expect(shouldSkipHookAdapter("claude-code", claudePayload)).toBeFalse();
    expect(shouldSkipHookAdapter("cursor", cursorPayload)).toBeFalse();
    expect(shouldSkipHookAdapter("codex", cursorPayload)).toBeFalse();
    expect(shouldSkipHookAdapter(null, cursorPayload)).toBeFalse();
  });

  test("requires the top-level key, tolerates junk payloads", () => {
    const mentionsInToolInput = JSON.stringify({
      session_id: "s",
      hook_event_name: "PreToolUse",
      tool_input: { command: "grep cursor_version file.ts" },
    });
    expect(shouldSkipHookAdapter("claude-code", mentionsInToolInput)).toBeFalse();
    expect(shouldSkipHookAdapter("claude-code", JSON.stringify({ cursor_version: 7 }))).toBeFalse();
    expect(shouldSkipHookAdapter("claude-code", JSON.stringify({ cursor_version: "" }))).toBeFalse();
    expect(shouldSkipHookAdapter("claude-code", "")).toBeFalse();
    expect(shouldSkipHookAdapter("claude-code", "   ")).toBeFalse();
    expect(shouldSkipHookAdapter("claude-code", "not json")).toBeFalse();
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
