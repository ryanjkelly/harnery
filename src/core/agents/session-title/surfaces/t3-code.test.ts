import { describe, expect, test } from "bun:test";
import { sessionNameDisplayBlock } from "../../session-name-display.ts";
import type { CompletedToolCall, TitleSurfaceContext } from "../types.ts";
import { isT3ThreadUpdateTool, T3_DELEGATED_THREAD_PREFIX, t3CodeSurface } from "./t3-code.ts";

const THREAD = "946f87f7-79bf-437b-8651-cc7fb936ab41";
const TITLE = "Agent Orion - T3 thread title API";
const CC_TOOL = "mcp__t3-code__t3_thread_update";
const CODEX_TOOL = "mcp__t3_code__t3_thread_update";

const claude: TitleSurfaceContext = { adapter: "claude-code", env: { T3CODE_THREAD_ID: THREAD } };
const codex: TitleSurfaceContext = { adapter: "codex", env: { T3CODE_THREAD_ID: THREAD } };

const ccResultText = JSON.stringify({
  threadId: THREAD,
  action: "rename",
  commandId: "cmd-1",
  sequence: 1173215,
  title: TITLE,
  titleRegeneration: null,
  linkedPullRequest: null,
  updatedAt: "2026-11-13T23:44:29.897Z",
});

function codexEnvelope(title: string, isError = false) {
  const body = { threadId: THREAD, action: "rename", title };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError,
  };
}

function done(toolName: string, input: unknown, response: unknown): CompletedToolCall {
  return { toolName, toolInput: input, toolResponse: response };
}

describe("detect", () => {
  test("matches Claude Code and Codex with a T3 thread id", () => {
    expect(t3CodeSurface.detect(claude)).toBe(true);
    expect(t3CodeSurface.detect(codex)).toBe(true);
  });
  test("prefers the stored client thread id", () => {
    expect(t3CodeSurface.detect({ adapter: "codex", env: {}, clientThreadId: THREAD })).toBe(true);
    expect(
      t3CodeSurface.clientThreadId?.({
        adapter: "codex",
        env: { T3CODE_THREAD_ID: "other" },
        clientThreadId: THREAD,
      }),
    ).toBe(THREAD);
  });
  test("excludes delegated child threads", () => {
    const child = {
      adapter: "codex" as const,
      env: { T3CODE_THREAD_ID: `${T3_DELEGATED_THREAD_PREFIX}abc` },
    };
    expect(t3CodeSurface.detect(child)).toBe(false);
    expect(t3CodeSurface.clientThreadId?.(child)).toBeUndefined();
  });
  test("excludes other adapters and missing ids", () => {
    expect(t3CodeSurface.detect({ adapter: "cursor", env: { T3CODE_THREAD_ID: THREAD } })).toBe(
      false,
    );
    expect(t3CodeSurface.detect({ adapter: "opencode", env: { T3CODE_THREAD_ID: THREAD } })).toBe(
      false,
    );
    expect(t3CodeSurface.detect({ adapter: null, env: { T3CODE_THREAD_ID: THREAD } })).toBe(false);
    expect(t3CodeSurface.detect({ adapter: "claude-code", env: {} })).toBe(false);
    expect(t3CodeSurface.detect({ adapter: "claude-code", env: { T3CODE_THREAD_ID: "" } })).toBe(
      false,
    );
  });
});

describe("tool name", () => {
  test("matches both adapters' spellings only", () => {
    expect(isT3ThreadUpdateTool(CC_TOOL)).toBe(true);
    expect(isT3ThreadUpdateTool(CODEX_TOOL)).toBe(true);
    expect(isT3ThreadUpdateTool("mcp__t3-code__t3_thread_read")).toBe(false);
    expect(isT3ThreadUpdateTool("t3_thread_update")).toBe(false);
    expect(isT3ThreadUpdateTool(undefined)).toBe(false);
  });
});

describe("wording", () => {
  test("Claude Code instruction names the tool, ToolSearch, and the fallback block", () => {
    const text = t3CodeSurface.instruction(TITLE, claude);
    expect(text).toContain(`\n${TITLE}\n`);
    expect(text).toContain("t3_thread_update");
    expect(text).toContain('action: "rename"');
    expect(text).toContain(CC_TOOL);
    expect(text).toContain("select:mcp__t3-code__t3_thread_update");
    expect(text).toContain(sessionNameDisplayBlock(TITLE));
    expect(text).toContain("regenerate_title");
    expect(text).toContain("threadId");
  });
  test("Codex instruction uses its tool name and omits ToolSearch", () => {
    const text = t3CodeSurface.instruction(TITLE, codex);
    expect(text).toContain(CODEX_TOOL);
    expect(text).not.toContain("ToolSearch");
    expect(text).toContain(sessionNameDisplayBlock(TITLE));
  });
  test("reminder is idempotent and carries the title", () => {
    const text = t3CodeSurface.reminder(TITLE, claude);
    expect(text).toContain(`\n${TITLE}\n`);
    expect(text).toContain("do nothing");
  });
});

describe("allowsWhilePending", () => {
  const allows = (toolName: string, input: unknown, ctx = claude) =>
    t3CodeSurface.allowsWhilePending?.({ toolName, toolInput: input }, [TITLE], ctx);

  test("allows the ToolSearch that loads the tool", () => {
    expect(allows("ToolSearch", { query: "select:mcp__t3-code__t3_thread_update" })).toBe(true);
    expect(allows("ToolSearch", { query: "select:Bash" })).toBe(false);
  });
  test("allows the exact rename on this thread", () => {
    expect(allows(CC_TOOL, { action: "rename", title: TITLE })).toBe(true);
    expect(allows(CODEX_TOOL, { action: "rename", title: TITLE, threadId: "" }, codex)).toBe(true);
    expect(allows(CC_TOOL, { action: "rename", title: TITLE, threadId: THREAD })).toBe(true);
  });
  test("refuses a wrong title, regenerate_title, another thread, or another tool", () => {
    expect(allows(CC_TOOL, { action: "rename", title: "Something else" })).toBe(false);
    expect(allows(CC_TOOL, { action: "regenerate_title" })).toBe(false);
    expect(allows(CC_TOOL, { action: "rename", title: TITLE, threadId: "other" })).toBe(false);
    expect(allows("Bash", { command: "ls" })).toBe(false);
  });
});

describe("confirmFromTool", () => {
  const confirm = (call: CompletedToolCall, ctx = claude) =>
    t3CodeSurface.confirmFromTool?.(call, [TITLE], ctx) ?? null;
  const input = { action: "rename", title: TITLE };

  test("confirms the Claude Code string and object result shapes", () => {
    expect(confirm(done(CC_TOOL, input, ccResultText))).toBe(TITLE);
    expect(confirm(done(CC_TOOL, input, JSON.parse(ccResultText)))).toBe(TITLE);
    expect(confirm(done(CC_TOOL, input, [{ type: "text", text: ccResultText }]))).toBe(TITLE);
  });
  test("confirms the Codex MCP envelope", () => {
    expect(confirm(done(CODEX_TOOL, input, codexEnvelope(TITLE)), codex)).toBe(TITLE);
    expect(confirm(done(CODEX_TOOL, input, JSON.stringify(codexEnvelope(TITLE))), codex)).toBe(
      TITLE,
    );
  });
  test("confirms against a stored thread id with no env", () => {
    const stored = { adapter: "codex" as const, env: {}, clientThreadId: THREAD };
    expect(
      confirm(done(CODEX_TOOL, { ...input, threadId: THREAD }, codexEnvelope(TITLE)), stored),
    ).toBe(TITLE);
  });
  test("rejects a wrong title, regenerate_title, another thread, and an error", () => {
    const wrong = { action: "rename", title: "Other" };
    expect(
      confirm(done(CC_TOOL, wrong, JSON.stringify({ action: "rename", title: "Other" }))),
    ).toBeNull();
    expect(
      confirm(done(CC_TOOL, input, JSON.stringify({ action: "rename", title: "Other" }))),
    ).toBeNull();
    expect(
      confirm(
        done(
          CC_TOOL,
          { action: "regenerate_title" },
          JSON.stringify({ action: "regenerate_title", title: TITLE }),
        ),
      ),
    ).toBeNull();
    expect(confirm(done(CC_TOOL, { ...input, threadId: "other" }, ccResultText))).toBeNull();
    expect(confirm(done(CODEX_TOOL, input, codexEnvelope(TITLE, true)), codex)).toBeNull();
    expect(confirm(done("Bash", input, ccResultText))).toBeNull();
  });
  test("survives cyclic responses", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(confirm(done(CC_TOOL, input, cyclic))).toBeNull();
  });
});

describe("failedAttempt", () => {
  const input = { action: "rename", title: TITLE };
  test("true for an errored or titleless rename", () => {
    expect(
      t3CodeSurface.failedAttempt?.(done(CODEX_TOOL, input, codexEnvelope(TITLE, true)), codex),
    ).toBe(true);
    expect(
      t3CodeSurface.failedAttempt?.(done(CC_TOOL, input, "Error: tool unavailable"), claude),
    ).toBe(true);
    expect(
      t3CodeSurface.failedAttempt?.(
        done(CC_TOOL, input, { action: "rename", title: "Other" }),
        claude,
      ),
    ).toBe(true);
  });
  test("false for a successful rename and for unrelated calls", () => {
    expect(t3CodeSurface.failedAttempt?.(done(CC_TOOL, input, ccResultText), claude)).toBe(false);
    expect(
      t3CodeSurface.failedAttempt?.(done(CODEX_TOOL, input, codexEnvelope(TITLE)), codex),
    ).toBe(false);
    expect(t3CodeSurface.failedAttempt?.(done("Bash", input, "boom"), claude)).toBe(false);
    expect(
      t3CodeSurface.failedAttempt?.(done(CC_TOOL, { action: "regenerate_title" }, "boom"), claude),
    ).toBe(false);
  });
});
