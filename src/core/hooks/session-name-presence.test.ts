/**
 * Regression cover for the naming-rule deadlock. The stop-hook naming rule
 * passes only on an in-window `turn.stop` carrying `session_name_present:
 * true`. When a satisfied name made this helper omit the field, no later stop
 * could ever carry it, so every reply blocked -- including the replies that
 * reproduced the exact name the rule was asking for.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionNamePresence } from "./session-name-presence.ts";

const NAME = "Agent Maya - Auth refactor";

function rootWith(body: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-name-presence-"));
  mkdirSync(path.join(root, ".harnery", "active"), { recursive: true });
  writeFileSync(
    path.join(root, ".harnery", "active", "self.json"),
    JSON.stringify({ schema_version: 1, instance_id: "self", ...body }),
    "utf8",
  );
  return root;
}

const noScan = () => false;

describe("sessionNamePresence", () => {
  test("reports nothing when no name has been suggested", () => {
    const root = rootWith({});
    expect(sessionNamePresence(root, "self", "any reply", noScan)).toEqual({});
  });

  test("reports false, with the name, when the reply omits it", () => {
    const root = rootWith({ suggested_session_name: NAME });
    expect(sessionNamePresence(root, "self", "no name here", noScan)).toEqual({
      session_name_present: false,
      session_name_present_for: NAME,
    });
  });

  test("reports true from the last assistant message and stamps the sighting", () => {
    const root = rootWith({ suggested_session_name: NAME });
    expect(sessionNamePresence(root, "self", `\`\`\`\n${NAME}\n\`\`\``, noScan)).toEqual({
      session_name_present: true,
      session_name_present_for: NAME,
    });
    // Stamped, so the next call takes the already-satisfied path below.
    expect(sessionNamePresence(root, "self", "unrelated reply", noScan)).toEqual({
      session_name_present: true,
      session_name_present_for: NAME,
    });
  });

  test("keeps reporting true on later turns once the name is stamped", () => {
    // THE deadlock: this used to return {} and the naming rule could never pass.
    const root = rootWith({
      suggested_session_name: NAME,
      session_name_seen_at: "2026-06-04T00:00:02Z",
      session_name_seen_for: NAME,
    });
    expect(sessionNamePresence(root, "self", "a reply about something else", noScan)).toEqual({
      session_name_present: true,
      session_name_present_for: NAME,
    });
  });

  test("re-scans when the stamp covers a different (earlier) name", () => {
    const root = rootWith({
      suggested_session_name: NAME,
      session_name_seen_at: "2026-06-04T00:00:02Z",
      session_name_seen_for: "Agent Maya - Earlier focus",
    });
    expect(sessionNamePresence(root, "self", "no name here", noScan)).toEqual({
      session_name_present: false,
      session_name_present_for: NAME,
    });
  });

  test("prefers the transcript scan over the last assistant message", () => {
    const root = rootWith({ suggested_session_name: NAME });
    const seen: string[] = [];
    const res = sessionNamePresence(root, "self", "", (name) => {
      seen.push(name);
      return true;
    });
    expect(seen).toEqual([NAME]);
    expect(res.session_name_present).toBe(true);
  });

  test("never throws on an unreadable coordination root", () => {
    expect(sessionNamePresence("/nonexistent/coord/root", "self", NAME, noScan)).toEqual({});
  });
});
