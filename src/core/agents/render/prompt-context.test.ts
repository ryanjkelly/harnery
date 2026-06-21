import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPromptContext } from "./prompt-context.ts";

let root: string;
let activeDir: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `agent-coord-prompt-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  activeDir = join(root, ".harnery", "active");
  mkdirSync(activeDir, { recursive: true });
  // Seed a self heartbeat with task set so the nudge stays quiet by default.
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(
    join(activeDir, "self.json"),
    JSON.stringify({
      schema_version: 1,
      instance_id: "self",
      name: "Maya",
      session_id: "self",
      task: "current focus",
      task_updated_at: now,
      files_touched: [],
      last_heartbeat: now,
      started_at: now,
    }),
    "utf8",
  );
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

describe("renderPromptContext", () => {
  test("no peers, no councils, fresh task → empty output", () => {
    const out = renderPromptContext({
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
    });
    expect(out).toBe("");
  });

  test("hash dedup: second call with no changes returns empty", () => {
    // Seed a peer
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(activeDir, "peer.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "peer",
        name: "Adelaide",
        session_id: "peer",
        files_touched: ["docs/x.md"],
        last_heartbeat: now,
        started_at: now,
      }),
      "utf8",
    );
    const first = renderPromptContext({
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
    });
    expect(first.length).toBeGreaterThan(0); // First call emits
    const second = renderPromptContext({
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
    });
    expect(second).toBe(""); // Hash dedup suppresses
  });

  test("task nudge fires when taskNudge=true AND task is empty", () => {
    // Replace self heartbeat with one that has no task
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(activeDir, "self.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "self",
        name: "Maya",
        session_id: "self",
        files_touched: [],
        last_heartbeat: now,
        started_at: now,
      }),
      "utf8",
    );
    const out = renderPromptContext({
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
      taskNudge: true,
    });
    expect(out).toContain("task");
  });

  test("task nudge does NOT fire when taskNudge=false (cc default)", () => {
    // Even with empty task, taskNudge=false suppresses
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(activeDir, "self.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "self",
        name: "Maya",
        session_id: "self",
        files_touched: [],
        last_heartbeat: now,
        started_at: now,
      }),
      "utf8",
    );
    const out = renderPromptContext({
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
      // taskNudge omitted
    });
    expect(out).not.toContain("task");
  });

  test("hash file gets created at .harnery/.last-peer-hash.<id>", () => {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(activeDir, "peer.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "peer",
        name: "Adelaide",
        session_id: "peer",
        files_touched: ["docs/x.md"],
        last_heartbeat: now,
        started_at: now,
      }),
      "utf8",
    );
    renderPromptContext({
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
    });
    const hashFile = join(root, ".harnery", ".last-peer-hash.self");
    expect(existsSync(hashFile)).toBe(true);
  });
});
