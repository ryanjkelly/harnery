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
  writeFileSync(
    join(root, ".harnery", "config.jsonc"),
    `{ "agents": { "requireGitFinalization": false } }`,
    "utf8",
  );
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

  test("Codex status footer is fresh on every prompt and preserves the answer", () => {
    const opts = {
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
      statusFooterNudge: true,
    };

    const first = renderPromptContext(opts);
    const second = renderPromptContext(opts);

    for (const out of [first, second]) {
      expect(out).toContain("complete the user's request first");
      expect(out).toContain("harn agents status");
      expect(out).toContain("bottom of the same substantive reply");
      expect(out).toContain("Keep the answer intact");
      expect(out).toContain("Stop hook is observe-only");
      expect(out).not.toContain("status --end-turn");
    }
  });

  test("Codex status footer requests the Git guard only when the host opts in", () => {
    writeFileSync(
      join(root, ".harnery", "config.jsonc"),
      `{ "agents": { "requireGitFinalization": true } }`,
      "utf8",
    );

    const out = renderPromptContext({
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
      statusFooterNudge: true,
    });

    expect(out).toContain("harn agents status --end-turn");
  });

  test("Codex status footer skips subagents and workflow children", () => {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    for (const extra of [{ kind: "subagent" }, { kind: "session", workflow_run_id: "wf-1" }]) {
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
          ...extra,
        }),
        "utf8",
      );
      const out = renderPromptContext({
        coordRoot: root,
        instanceId: "self",
        sessionId: "self",
        agentName: "Maya",
        statusFooterNudge: true,
      });
      expect(out).not.toContain("Codex status footer");
    }
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

  test("first-session nudge tells every adapter how to print the suggested name", () => {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(activeDir, "self.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "self",
        name: "Maya",
        session_id: "self",
        kind: "session",
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
      sessionNameNudge: true,
    });
    expect(out).toContain('harn agents set-task "<2-5 word session topic>"');
    expect(out).toContain("first_of_session: true");
    expect(out).toContain("`suggested_session_name`");
    expect(out).toContain("fenced code block");
  });

  test("first-session nudge re-emits on every prompt until a name is produced", () => {
    // Deliberately NOT deduped: "still unnamed" is the failure state, and a
    // one-shot reminder erased by dedup was the operator-reported miss mode.
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(activeDir, "self.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "self",
        name: "Maya",
        session_id: "self",
        kind: "session",
        files_touched: [],
        last_heartbeat: now,
        started_at: now,
      }),
      "utf8",
    );
    const opts = {
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
      sessionNameNudge: true,
      taskNudge: true,
    };
    expect(renderPromptContext(opts)).toContain("suggested_session_name");
    const second = renderPromptContext(opts);
    expect(second).toContain("suggested_session_name");
    // The naming reminder supersedes the generic task-unset reminder.
    expect(second).not.toContain("task` field is unset");
  });

  test("first-session nudge still fires after a bare clear (clears never name)", () => {
    // A first declaration of "" stamps task_updated_at but produces no name;
    // the naming window must stay open.
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(activeDir, "self.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "self",
        name: "Maya",
        session_id: "self",
        kind: "session",
        task_updated_at: now,
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
      sessionNameNudge: true,
    });
    expect(out).toContain("suggested_session_name");
  });

  test("first-session nudge stops once the session has been named", () => {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(
      join(activeDir, "self.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "self",
        name: "Maya",
        session_id: "self",
        kind: "session",
        task: "Auth refactor",
        task_updated_at: now,
        suggested_session_name: "Agent Maya - Auth refactor",
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
      sessionNameNudge: true,
    });
    expect(out).not.toContain("suggested_session_name");
  });

  test("first-session nudge skips subagents and workflow children", () => {
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    for (const extra of [{ kind: "subagent" }, { kind: "session", workflow_run_id: "wf-1" }]) {
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
          ...extra,
        }),
        "utf8",
      );
      const out = renderPromptContext({
        coordRoot: root,
        instanceId: "self",
        sessionId: "self",
        agentName: "Maya",
        sessionNameNudge: true,
        taskNudge: true,
      });
      expect(out).not.toContain("suggested_session_name");
      expect(out).not.toContain("task` field is unset");
    }
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
