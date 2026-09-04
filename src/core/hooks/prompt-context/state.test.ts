import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupExpiredCursorPromptContext,
  clearCursorPromptContextSession,
  consumeCursorPromptContext,
  markCursorPromptContextRecovery,
  stageCursorPromptContext,
  startCursorPromptContextSession,
} from "./state.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harnery-prompt-context-"));
  roots.push(value);
  return value;
}

describe("Cursor prompt-context state", () => {
  test("issues a 32-byte opaque key and stores only hashed filenames and identifiers", () => {
    const coordRoot = root();
    const conversationId = "conversation-secret";
    const turnId = "native-turn-secret";
    const session = startCursorPromptContextSession({ coordRoot, conversationId, nowMs: 1_000 });

    expect(Buffer.from(session.sessionKey, "base64url")).toHaveLength(32);
    expect(session.sessionKey).not.toContain(conversationId);
    expect(
      stageCursorPromptContext({
        coordRoot,
        conversationId,
        turnId,
        context: "private prefetched context",
        nowMs: 2_000,
      }).staged,
    ).toBe(true);

    const stateRoot = join(coordRoot, ".harnery", "runtime", "prompt-context");
    const allPaths = ["sessions", "pending"].flatMap((dir) =>
      readdirSync(join(stateRoot, dir)).map((name) => join(stateRoot, dir, name)),
    );
    expect(allPaths).toHaveLength(2);
    for (const path of allPaths) {
      expect(path).not.toContain(conversationId);
      expect(path).not.toContain(turnId);
      expect(path).not.toContain(session.sessionKey);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    for (const dir of [stateRoot, join(stateRoot, "sessions"), join(stateRoot, "pending")]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    const disk = allPaths.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(disk).not.toContain(conversationId);
    expect(disk).not.toContain(turnId);
    expect(disk).not.toContain(session.sessionKey);
    expect(disk).toContain("private prefetched context");
  });

  test("atomically consumes a staged turn once", () => {
    const coordRoot = root();
    const { sessionKey } = startCursorPromptContextSession({
      coordRoot,
      conversationId: "conversation-1",
      nowMs: 1_000,
    });
    stageCursorPromptContext({
      coordRoot,
      conversationId: "conversation-1",
      turnId: "turn-1",
      context: "<order-context>ready</order-context>",
      nowMs: 2_000,
    });

    const first = consumeCursorPromptContext({ coordRoot, sessionKey, nowMs: 3_000 });
    expect(first).toMatchObject({
      status: "consumed",
      context: "<order-context>ready</order-context>",
    });
    if (first.status === "consumed") {
      expect(first.conversationFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(first.turnFingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(consumeCursorPromptContext({ coordRoot, sessionKey, nowMs: 3_001 })).toEqual({
      status: "empty",
    });
  });

  test("recovers the current conversation's native-turn envelope once", () => {
    const coordRoot = root();
    startCursorPromptContextSession({
      coordRoot,
      conversationId: "conversation-1",
      nowMs: 1_000,
    });
    stageCursorPromptContext({
      coordRoot,
      conversationId: "conversation-1",
      turnId: "turn-1",
      context: "context",
      nowMs: 2_000,
    });

    expect(
      markCursorPromptContextRecovery({
        coordRoot,
        conversationId: "conversation-other",
        nowMs: 3_000,
      }),
    ).toEqual({ send: false, reason: "empty" });
    expect(
      markCursorPromptContextRecovery({
        coordRoot,
        conversationId: "conversation-1",
        nowMs: 3_000,
      }),
    ).toEqual({ send: true, reason: "pending" });
    expect(
      markCursorPromptContextRecovery({
        coordRoot,
        conversationId: "conversation-1",
        nowMs: 3_001,
      }),
    ).toEqual({ send: false, reason: "already_sent" });
  });

  test("expires pending context and rejects malformed keys", () => {
    const coordRoot = root();
    const { sessionKey } = startCursorPromptContextSession({
      coordRoot,
      conversationId: "conversation-1",
      nowMs: 1_000,
    });
    stageCursorPromptContext({
      coordRoot,
      conversationId: "conversation-1",
      turnId: "turn-1",
      context: "context",
      nowMs: 2_000,
      ttlMs: 50,
    });

    expect(
      consumeCursorPromptContext({ coordRoot, sessionKey: "not-a-key", nowMs: 2_010 }),
    ).toEqual({ status: "invalid_key" });
    expect(consumeCursorPromptContext({ coordRoot, sessionKey, nowMs: 2_051 })).toEqual({
      status: "empty",
    });
  });

  test("session restart and end cleanup make old keys empty", () => {
    const coordRoot = root();
    const first = startCursorPromptContextSession({
      coordRoot,
      conversationId: "conversation-1",
      nowMs: 1_000,
    });
    stageCursorPromptContext({
      coordRoot,
      conversationId: "conversation-1",
      turnId: "turn-1",
      context: "old",
      nowMs: 2_000,
    });
    const second = startCursorPromptContextSession({
      coordRoot,
      conversationId: "conversation-1",
      nowMs: 3_000,
    });
    expect(first.sessionKey).not.toBe(second.sessionKey);
    expect(
      consumeCursorPromptContext({ coordRoot, sessionKey: first.sessionKey, nowMs: 3_001 }),
    ).toEqual({ status: "empty" });

    stageCursorPromptContext({
      coordRoot,
      conversationId: "conversation-1",
      turnId: "turn-2",
      context: "new",
      nowMs: 4_000,
    });
    clearCursorPromptContextSession({
      coordRoot,
      conversationId: "conversation-1",
      nowMs: 4_001,
    });
    expect(
      consumeCursorPromptContext({ coordRoot, sessionKey: second.sessionKey, nowMs: 4_002 }),
    ).toEqual({ status: "empty" });
  });

  test("a no-match turn clears stale context and janitor removes expired sessions", () => {
    const coordRoot = root();
    const { sessionKey } = startCursorPromptContextSession({
      coordRoot,
      conversationId: "conversation-1",
      nowMs: 1_000,
      sessionTtlMs: 100,
    });
    stageCursorPromptContext({
      coordRoot,
      conversationId: "conversation-1",
      turnId: "turn-1",
      context: "stale",
      nowMs: 1_010,
    });
    expect(
      stageCursorPromptContext({
        coordRoot,
        conversationId: "conversation-1",
        turnId: "turn-2",
        context: "",
        nowMs: 1_020,
      }),
    ).toEqual({ staged: false, reason: "empty_context" });
    expect(consumeCursorPromptContext({ coordRoot, sessionKey, nowMs: 1_021 })).toEqual({
      status: "empty",
    });

    cleanupExpiredCursorPromptContext(coordRoot, 1_101);
    expect(
      readdirSync(join(coordRoot, ".harnery", "runtime", "prompt-context", "sessions")),
    ).toEqual([]);
  });
});
