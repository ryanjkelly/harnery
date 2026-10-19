/**
 * Locks setTask's session-naming semantics: the suggested name is built on the
 * first NON-EMPTY declaration of a human-facing session and never rebuilt; a
 * bare clear must not consume the naming window; subagents / transient /
 * workflow children are never named; stampSessionNameSeen is idempotent.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSuggestedName,
  readHeartbeat,
  setAssignedNameCache,
  setTask,
  stampSessionNameSeen,
} from "./heartbeat-writer.ts";

let root: string;
let activeDir: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `agent-coord-naming-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  activeDir = join(root, ".harnery", "active");
  mkdirSync(activeDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

function seed(extra: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(
    join(activeDir, "self.json"),
    JSON.stringify({
      schema_version: 2,
      instance_id: "self",
      name: "Maya",
      kind: "session",
      session_id: "self",
      files_touched: [],
      last_heartbeat: ts,
      started_at: ts,
      ...extra,
    }),
    "utf8",
  );
}

function readSelf(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(activeDir, "self.json"), "utf8"));
}

test("heartbeat paths reject traversal before touching the filesystem", () => {
  expect(() => readHeartbeat(root, "../outside")).toThrow(/instance_id/);
  expect(() => readHeartbeat(root, "nested/owner")).toThrow(/instance_id/);
});

describe("setTask session naming", () => {
  test("first non-empty declaration builds and stamps the name", () => {
    seed();
    const hb = setTask(root, "self", "Auth refactor");
    expect(hb?.suggested_session_name).toBe("Agent Maya - Auth refactor");
    expect(readSelf().suggested_session_name).toBe("Agent Maya - Auth refactor");
  });

  test("a bare clear never consumes the naming window", () => {
    seed();
    const cleared = setTask(root, "self", "");
    expect(cleared?.suggested_session_name).toBeUndefined();
    expect(cleared?.task_updated_at).toBeTruthy();
    // The next non-empty declaration still names the session.
    const hb = setTask(root, "self", "Auth refactor");
    expect(hb?.suggested_session_name).toBe("Agent Maya - Auth refactor");
  });

  test("the name is built once and never rebuilt on later declarations", () => {
    seed();
    setTask(root, "self", "Auth refactor");
    const hb = setTask(root, "self", "New topic entirely");
    expect(hb?.suggested_session_name).toBe("Agent Maya - Auth refactor");
  });

  test("subagents, transient rows, and workflow children are never named", () => {
    for (const extra of [
      { kind: "subagent" },
      { kind: "transient" },
      { kind: "session", workflow_run_id: "wf-1" },
    ]) {
      seed(extra);
      const hb = setTask(root, "self", "Auth refactor");
      expect(hb?.suggested_session_name).toBeUndefined();
    }
  });

  test("missing agent name falls back to unknown", () => {
    seed({ name: undefined });
    const hb = setTask(root, "self", "Auth refactor");
    expect(hb?.suggested_session_name).toBe("Agent unknown - Auth refactor");
  });

  test("late name assignment repairs a pending unknown title", () => {
    seed({
      name: undefined,
      suggested_session_name: "Agent unknown - Auth refactor",
      session_name_seen_for: "Agent unknown - Auth refactor",
    });

    const hb = setAssignedNameCache(root, "self", "Maya");

    expect(hb?.name).toBe("Maya");
    expect(hb?.suggested_session_name).toBe("Agent Maya - Auth refactor");
    expect(hb?.session_name_seen_for).toBe("Agent unknown - Auth refactor");
  });
});

describe("stampSessionNameSeen", () => {
  test("stamps once and is idempotent", () => {
    seed({ suggested_session_name: "Agent Maya - Auth refactor" });
    const first = stampSessionNameSeen(root, "self");
    const stamp = first?.session_name_seen_at;
    expect(stamp).toBeTruthy();
    const second = stampSessionNameSeen(root, "self");
    expect(second?.session_name_seen_at).toBe(stamp as string);
  });

  // The sighting has to record WHICH name it was for. Keyed on the timestamp
  // alone, a re-minted suggested name inherits the earlier sighting, the
  // turn.completed scan stays off forever, `session_name_present` is never emitted
  // again, and the Stop-hook naming rule blocks every reply from then on --
  // including the reply that reproduced the name it asked for.
  test("records which name the sighting was for, and re-records on a new name", () => {
    seed({ suggested_session_name: "Agent Maya - Auth refactor" });
    const first = stampSessionNameSeen(root, "self", "Agent Maya - Auth refactor");
    expect(first?.session_name_seen_for).toBe("Agent Maya - Auth refactor");
    const stamp = first?.session_name_seen_at;

    const second = stampSessionNameSeen(root, "self", "Agent Maya - Billing sweep");
    expect(second?.session_name_seen_for).toBe("Agent Maya - Billing sweep");
    // The original sighting time is preserved; only the name it covers moves.
    expect(second?.session_name_seen_at).toBe(stamp as string);
  });
});

describe("buildSuggestedName", () => {
  test("collapses whitespace and trims", () => {
    expect(buildSuggestedName("Maya", ["  Auth ", "", " Refactor  "])?.suggestedName).toBe(
      "Agent Maya - Auth Refactor",
    );
  });

  test("returns null on an empty description", () => {
    expect(buildSuggestedName("Maya", [])).toBeNull();
    expect(buildSuggestedName("Maya", ["", "   "])).toBeNull();
  });
});
