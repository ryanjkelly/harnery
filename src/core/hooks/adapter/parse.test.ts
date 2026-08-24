import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER_SPECS } from "./events.ts";
import { normalizeEventName, parsePayload } from "./parse.ts";

describe("parsePayload session ids", () => {
  test("normalizes Cursor Glass bc- ids in parsed and owner-resolution fields", () => {
    const payload = parsePayload(
      JSON.stringify({
        session_id: "bc-session-one",
        conversation_id: "bc-session-one",
        parent_session_id: "bc-parent-one",
      }),
      "cursor",
    );

    expect(payload).toMatchObject({
      session_id: "session-one",
      conversation_id: "session-one",
      parent_session_id: "parent-one",
      raw: {
        session_id: "session-one",
        conversation_id: "session-one",
        parent_session_id: "parent-one",
      },
    });
  });

  test("classifies Cursor local and cloud execution surfaces without retaining mode text", () => {
    const local = parsePayload(
      JSON.stringify({ session_id: "local-session", is_background_agent: false }),
      "cursor",
    );
    const cloud = parsePayload(JSON.stringify({ conversation_id: "bc-cloud-session" }), "cursor");

    expect(local).toMatchObject({ session_id: "local-session", cursor_mode: "local" });
    expect(cloud).toMatchObject({ conversation_id: "cloud-session", cursor_mode: "cloud" });
  });

  test("does not rewrite bc- ids from other adapters", () => {
    const payload = parsePayload(
      JSON.stringify({ session_id: "bc-session-one", conversation_id: "bc-session-one" }),
      "claude-code",
    );

    expect(payload).toMatchObject({
      session_id: "bc-session-one",
      conversation_id: "bc-session-one",
      raw: { session_id: "bc-session-one", conversation_id: "bc-session-one" },
    });
  });
});

describe("Cursor shell hook payloads", () => {
  test("normalizes shell fallbacks into pairable tool payloads", () => {
    const before = parsePayload(
      JSON.stringify({
        conversation_id: "cursor-session",
        generation_id: "cursor-turn",
        hook_event_name: "beforeShellExecution",
        command: "harn agents status --end-turn",
      }),
      "cursor",
    );
    const after = parsePayload(
      JSON.stringify({
        conversation_id: "cursor-session",
        generation_id: "cursor-turn",
        hook_event_name: "afterShellExecution",
        command: "harn agents status --end-turn",
        output: "ok",
      }),
      "cursor",
    );

    expect(before).toMatchObject({
      turn_id: "cursor-turn",
      tool_name: "Shell",
      tool_input: { command: "harn agents status --end-turn" },
    });
    expect(after).toMatchObject({
      turn_id: "cursor-turn",
      tool_name: "Shell",
      tool_input: { command: "harn agents status --end-turn" },
      tool_response: "ok",
    });
    expect(normalizeEventName("after-shell-execution")).toEqual({
      event_type: "tool.completed",
      intra_turn: true,
    });
  });

  test("parses stringified generic tool input", () => {
    expect(
      parsePayload(
        JSON.stringify({ tool_name: "Shell", tool_input: '{"command":"harn doctor"}' }),
        "cursor",
      ),
    ).toMatchObject({ tool_input: { command: "harn doctor" } });
  });

  test("preserves PreToolUse agent_message for the display latch", () => {
    expect(
      parsePayload(
        JSON.stringify({
          hook_event_name: "preToolUse",
          agent_message: "```\nAgent Maya - Auth refactor\n```",
        }),
        "cursor",
      ),
    ).toMatchObject({ agent_message: "```\nAgent Maya - Auth refactor\n```" });
  });
});

describe("Codex PermissionRequest contract fixture", () => {
  test("normalizes verified adapter evidence to wait.started", () => {
    const raw = readFileSync(
      join(import.meta.dir, "../../../../tests/fixtures/adapters/codex/permission-request.json"),
      "utf8",
    );
    const payload = parsePayload(raw, "codex");

    expect(payload).toMatchObject({
      hook_event_name: "PermissionRequest",
      session_id: "019ff6e8-ba69-71e2-9d5f-3ae7a4bd918a",
      turn_id: "turn-7d0f4f9c",
      tool_name: "shell_command",
      tool_input: {
        description: "Inspect the working tree outside the sandbox",
      },
    });
    expect(normalizeEventName("permission-request")).toEqual({
      event_type: "wait.started",
      intra_turn: true,
    });
  });
});

describe("installed adapter events", () => {
  test("every installed hook is canonical or an explicit evidence-only boundary", () => {
    for (const [adapter, spec] of Object.entries(ADAPTER_SPECS)) {
      for (const event of spec.events) {
        if (event.subcommand === "after-agent-response") {
          expect(adapter).toBe("cursor");
          expect(normalizeEventName(event.subcommand)).toBeNull();
          continue;
        }
        expect(
          normalizeEventName(event.subcommand),
          `${adapter}:${event.settingsKey}`,
        ).not.toBeNull();
      }
    }
  });
});

describe("parsePayload effort", () => {
  test("plucks CC's effort.level object", () => {
    const payload = parsePayload(
      JSON.stringify({ session_id: "s", effort: { level: "xhigh" } }),
      "claude-code",
    );
    expect(payload?.effort).toBe("xhigh");
  });

  test("tolerates a flattened effort string", () => {
    const payload = parsePayload(JSON.stringify({ session_id: "s", effort: "low" }), "claude-code");
    expect(payload?.effort).toBe("low");
  });

  test("leaves effort undefined when absent or malformed", () => {
    expect(
      parsePayload(JSON.stringify({ session_id: "s" }), "claude-code")?.effort,
    ).toBeUndefined();
    expect(
      parsePayload(JSON.stringify({ session_id: "s", effort: { level: 3 } }), "claude-code")
        ?.effort,
    ).toBeUndefined();
    expect(
      parsePayload(JSON.stringify({ session_id: "s", effort: [] }), "claude-code")?.effort,
    ).toBeUndefined();
  });
});
