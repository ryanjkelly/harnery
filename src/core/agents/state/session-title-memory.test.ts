import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clientThreadTitles, latestClientThreadTitle } from "./session-title-memory.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-title-memory-"));
  roots.push(root);
  mkdirSync(path.join(root, ".harnery", "session-titles"), { recursive: true });
  return root;
}

function remember(
  root: string,
  instanceId: string,
  fields: Record<string, unknown>,
  ageSeconds = 0,
): void {
  const file = path.join(root, ".harnery", "session-titles", `${instanceId}.json`);
  writeFileSync(
    file,
    JSON.stringify({ instance_id: instanceId, session_id: instanceId, ...fields }),
  );
  const at = new Date(Date.now() - ageSeconds * 1000);
  utimesSync(file, at, at);
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("client thread titles", () => {
  test("lists only titles a writing surface confirmed on a thread", () => {
    const root = makeRoot();
    remember(root, "applied", {
      session_title_surface: "t3-code",
      session_title_client_thread: "thread-1",
      session_title_applied_for: "Agent A - first",
    });
    // Minted but never confirmed on the client.
    remember(root, "pending", {
      session_title_surface: "t3-code",
      session_title_client_thread: "thread-1",
      suggested_session_name: "Agent B - second",
    });
    // The name block has no client thread.
    remember(root, "block", {
      session_title_surface: "name-block",
      suggested_session_name: "Agent C - third",
    });
    writeFileSync(path.join(root, ".harnery", "session-titles", "broken.json"), "{");

    expect(clientThreadTitles(root).map(({ title }) => title)).toEqual(["Agent A - first"]);
    expect(clientThreadTitles(path.join(root, "missing"))).toEqual([]);
  });

  test("the newest confirmed title for the same surface and thread wins", () => {
    const root = makeRoot();
    const row = { session_title_surface: "t3-code", session_title_client_thread: "thread-1" };
    remember(root, "old", { ...row, session_title_applied_for: "Agent A - first" }, 600);
    remember(root, "new", { ...row, session_title_applied_for: "[DONE] Agent A - first" }, 60);
    remember(
      root,
      "elsewhere",
      { ...row, session_title_client_thread: "thread-2", session_title_applied_for: "Agent Z - z" },
      1,
    );
    const titles = clientThreadTitles(root);

    expect(latestClientThreadTitle(titles, "t3-code", "thread-1")).toBe("[DONE] Agent A - first");
    expect(latestClientThreadTitle(titles, "t3-code", "thread-2")).toBe("Agent Z - z");
    expect(latestClientThreadTitle(titles, "t3-code", "thread-3")).toBeUndefined();
    expect(latestClientThreadTitle(titles, "other-surface", "thread-1")).toBeUndefined();
    expect(latestClientThreadTitle(titles, "t3-code", undefined)).toBeUndefined();
  });
});
