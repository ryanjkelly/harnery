import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatPendingCouncils, renderSessionContext } from "./session-context.ts";

let root: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `agent-coord-session-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
});

describe("renderSessionContext", () => {
  test("self-only, no peers → just self-name line", () => {
    const out = renderSessionContext({
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
    });
    expect(out).toContain("You are agent-Maya.");
    expect(out).not.toContain("(Cursor)");
    expect(out).not.toContain("(Codex)");
  });

  test("platformLabel renders harness suffix on self-name", () => {
    const out = renderSessionContext({
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
      platformLabel: "Cursor",
    });
    expect(out).toContain("You are agent-Maya (Cursor).");
  });

  test("with peer present → renders peer table", () => {
    writeFileSync(
      join(root, ".harnery", "active", "peer.json"),
      JSON.stringify({
        schema_version: 1,
        instance_id: "peer",
        name: "Adelaide",
        session_id: "peer",
        files_touched: ["docs/x.md"],
        last_heartbeat: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        started_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
      "utf8",
    );
    const out = renderSessionContext({
      coordRoot: root,
      instanceId: "self",
      sessionId: "self",
      agentName: "Maya",
    });
    expect(out).toContain("agent-Adelaide");
  });
});

describe("formatPendingCouncils", () => {
  test("no councils dir → empty string", () => {
    expect(formatPendingCouncils(root, "Maya")).toBe("");
  });

  test("active open council with member listed → returns reminder string", () => {
    mkdirSync(join(root, ".harnery", "councils"), { recursive: true });
    writeFileSync(
      join(root, ".harnery", "councils", "test-council-2026-05-27-aaaa.json"),
      JSON.stringify({
        council_id: "test-council-2026-05-27-aaaa",
        status: "active",
        round_status: "open",
        current_round: 1,
        members: ["agent-Maya"],
      }),
      "utf8",
    );
    const out = formatPendingCouncils(root, "Maya");
    expect(out).toContain("Council waiting on your input");
    expect(out).toContain("test-council-2026-05-27-aaaa");
  });

  test("closed council → no reminder", () => {
    mkdirSync(join(root, ".harnery", "councils"), { recursive: true });
    writeFileSync(
      join(root, ".harnery", "councils", "closed-2026-05-27-bbbb.json"),
      JSON.stringify({
        council_id: "closed-2026-05-27-bbbb",
        status: "closed",
        round_status: "open",
        current_round: 1,
        members: ["agent-Maya"],
      }),
      "utf8",
    );
    expect(formatPendingCouncils(root, "Maya")).toBe("");
  });

  test("member already contributed in current round → no reminder", () => {
    const cid = "contributed-2026-05-27-cccc";
    mkdirSync(join(root, ".harnery", "councils", cid, "round-1"), { recursive: true });
    writeFileSync(
      join(root, ".harnery", "councils", `${cid}.json`),
      JSON.stringify({
        council_id: cid,
        status: "active",
        round_status: "open",
        current_round: 1,
        members: ["agent-Maya"],
      }),
      "utf8",
    );
    writeFileSync(
      join(root, ".harnery", "councils", cid, "round-1", "agent-Maya.md"),
      "my contribution",
      "utf8",
    );
    expect(formatPendingCouncils(root, "Maya")).toBe("");
  });
});
