import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
