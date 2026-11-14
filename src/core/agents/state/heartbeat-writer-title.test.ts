/**
 * Locks the session-title writers (ADR 0247) and proves the four title fields
 * travel the same path as the name-display fields: stamped on the
 * generation-bound cache, returned by the live row reader the hooks use, and
 * carried across a forced cache rebuild of the same native session.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import {
  readHeartbeat,
  stampSessionTitleApplied,
  stampSessionTitleFallback,
  stampSessionTitleSurface,
} from "./heartbeat-writer.ts";
import { readLiveCoordinationRow } from "./live-coordination-view.ts";
import { repairLiveCoordinationHeartbeat } from "./live-coordination-writer.ts";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `harnery-title-${process.pid}-${crypto.randomUUID()}`);
  initializeV3Fixture(root);
  seedV3Session(root, "self", { name: "Maya" });
});

afterEach(() => removeDir(root));

function patchCache(extra: Record<string, unknown>): void {
  const path = join(root, ".harnery", "active", "self.json");
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...extra }),
    "utf8",
  );
}

describe("session-title writers", () => {
  test("empty inputs return null without writing", () => {
    const before = readFileSync(join(root, ".harnery", "active", "self.json"), "utf8");
    expect(stampSessionTitleSurface(root, "self", "")).toBeNull();
    expect(stampSessionTitleApplied(root, "self", "", "t3-code")).toBeNull();
    expect(stampSessionTitleApplied(root, "self", "Agent Maya - x", "")).toBeNull();
    expect(stampSessionTitleFallback(root, "self", "")).toBeNull();
    expect(readFileSync(join(root, ".harnery", "active", "self.json"), "utf8")).toBe(before);
  });

  test("surface records the thread id and is idempotent", () => {
    stampSessionTitleSurface(root, "self", "t3-code", "thread-1");
    const again = stampSessionTitleSurface(root, "self", "t3-code", "thread-1");
    expect(again?.session_title_surface).toBe("t3-code");
    expect(again?.session_title_client_thread).toBe("thread-1");
    // Before any title is applied, a different resolution may replace it.
    expect(stampSessionTitleSurface(root, "self", "name-block")?.session_title_surface).toBe(
      "name-block",
    );
  });

  test("the surface that applied the title keeps it", () => {
    stampSessionTitleApplied(root, "self", "Agent Maya - x", "t3-code");
    const after = stampSessionTitleSurface(root, "self", "name-block", "thread-2");
    expect(after?.session_title_surface).toBe("t3-code");
    expect(after?.session_title_client_thread).toBeUndefined();
    expect(stampSessionTitleSurface(root, "self", "t3-code", "thread-3")).toMatchObject({
      session_title_surface: "t3-code",
      session_title_client_thread: "thread-3",
    });
  });

  test("applied clears fallback and closes a pending name latch, even after drift", () => {
    patchCache({ suggested_session_name: "Agent Maya - current" });
    stampSessionTitleFallback(root, "self", "Agent Maya - earlier");
    const applied = stampSessionTitleApplied(root, "self", "Agent Maya - earlier", "t3-code");
    expect(applied?.session_title_applied_for).toBe("Agent Maya - earlier");
    expect(applied?.session_title_surface).toBe("t3-code");
    expect(applied?.session_title_fallback_for).toBeUndefined();
    expect(applied?.session_name_seen_for).toBe("Agent Maya - current");
    expect(typeof applied?.session_name_seen_at).toBe("string");
  });

  test("applied leaves an already-seen name alone", () => {
    patchCache({
      suggested_session_name: "Agent Maya - now",
      session_name_seen_for: "Agent Maya - now",
      session_name_seen_at: "2026-01-01T00:00:00Z",
    });
    const applied = stampSessionTitleApplied(root, "self", "Agent Maya - now", "t3-code");
    expect(applied?.session_name_seen_at).toBe("2026-01-01T00:00:00Z");
    expect(applied?.session_name_seen_for).toBe("Agent Maya - now");
  });

  test("fallback is idempotent", () => {
    stampSessionTitleFallback(root, "self", "Agent Maya - x");
    expect(stampSessionTitleFallback(root, "self", "Agent Maya - x")).toMatchObject({
      session_title_fallback_for: "Agent Maya - x",
    });
  });
});

describe("session-title fields on the live row", () => {
  test("stamped fields come back through the hooks' row reader and survive a rebuild", () => {
    stampSessionTitleSurface(root, "self", "t3-code", "thread-1");
    stampSessionTitleApplied(root, "self", "Agent Maya - x", "t3-code");
    stampSessionTitleFallback(root, "self", "Agent Maya - y");
    const expected = {
      session_title_surface: "t3-code",
      session_title_client_thread: "thread-1",
      session_title_applied_for: "Agent Maya - x",
      session_title_fallback_for: "Agent Maya - y",
    };
    expect(readLiveCoordinationRow(root, "self")).toMatchObject(expected);

    expect(repairLiveCoordinationHeartbeat(root, "self", "self", "codex")).toMatchObject(expected);
    expect(readHeartbeat(root, "self")).toMatchObject(expected);
    expect(readLiveCoordinationRow(root, "self")).toMatchObject(expected);
  });
});
