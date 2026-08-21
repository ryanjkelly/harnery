import { describe, expect, test } from "bun:test";
import { nativeSessionIdentity } from "./agents.ts";

describe("nativeSessionIdentity", () => {
  test("prefers the cache's native adapter session ID", () => {
    expect(
      nativeSessionIdentity(
        { native_session_id: "native-session", session_id: `sid_${"a".repeat(64)}` },
        "owner",
      ),
    ).toBe("native-session");
  });

  test("falls back to the owner for a projection-only canonical session ID", () => {
    expect(nativeSessionIdentity({ session_id: `sid_${"a".repeat(64)}` }, "native-owner")).toBe(
      "native-owner",
    );
  });

  test("keeps a non-canonical session ID", () => {
    expect(nativeSessionIdentity({ session_id: "adapter-session" }, "owner")).toBe(
      "adapter-session",
    );
  });
});
