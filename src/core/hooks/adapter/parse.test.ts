import { describe, expect, test } from "bun:test";
import { parsePayload } from "./parse.ts";

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
