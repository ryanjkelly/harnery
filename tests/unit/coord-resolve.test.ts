/**
 * Resolution tests: harness detection, pid-map row format, and owner
 * resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectHarness } from "../../src/core/hooks/harness/detect.ts";
import { listPidmap, resolveOwner } from "../../src/core/hooks/resolve/owner.ts";
import { writePidmapRow } from "../../src/core/agents/state/pidmap.ts";

describe("detectHarness", () => {
  const saved = process.env.HARNERY_AGENT_COORD_HARNESS;
  afterEach(() => {
    if (saved === undefined) delete process.env.HARNERY_AGENT_COORD_HARNESS;
    else process.env.HARNERY_AGENT_COORD_HARNESS = saved;
  });

  test("--harness flag wins (both spaced + = form)", () => {
    expect(detectHarness(["--harness", "cursor"])).toBe("cursor");
    expect(detectHarness(["--harness=codex"])).toBe("codex");
  });

  test("falls back to HARNERY_AGENT_COORD_HARNESS env when flag absent", () => {
    process.env.HARNERY_AGENT_COORD_HARNESS = "cursor";
    expect(detectHarness([])).toBe("cursor");
  });

  test("legacy claude_code (underscore) maps to claude-code", () => {
    expect(detectHarness(["--harness", "claude_code"])).toBe("claude-code");
    process.env.HARNERY_AGENT_COORD_HARNESS = "claude_code";
    expect(detectHarness([])).toBe("claude-code");
  });

  test("unknown / missing → null", () => {
    delete process.env.HARNERY_AGENT_COORD_HARNESS;
    expect(detectHarness([])).toBeNull();
    expect(detectHarness(["--harness", "emacs"])).toBeNull();
  });
});

describe("pid-map row format + resolveOwner", () => {
  let root: string;
  const savedOwner = process.env.HARNERY_AGENT_COORD_OWNER;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-resolve-"));
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    delete process.env.HARNERY_AGENT_COORD_OWNER;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedOwner === undefined) delete process.env.HARNERY_AGENT_COORD_OWNER;
    else process.env.HARNERY_AGENT_COORD_OWNER = savedOwner;
  });

  test("writePidmapRow writes `<instance_id>\\t<platform>` + is idempotent", () => {
    writePidmapRow(root, 4242, "sess-abc", "cursor");
    const rows = listPidmap(root);
    const row = rows.find((r) => r.pid === 4242);
    expect(row?.owner).toBe("sess-abc"); // listPidmap splits on the tab, returns owner
    // idempotent re-write: no throw, same result
    writePidmapRow(root, 4242, "sess-abc", "cursor");
    expect(listPidmap(root).filter((r) => r.pid === 4242).length).toBe(1);
  });

  test("resolveOwner honors HARNERY_AGENT_COORD_OWNER env (source=env)", () => {
    process.env.HARNERY_AGENT_COORD_OWNER = "env-owner-id";
    expect(resolveOwner({ payload: null, coordRoot: root })).toEqual({
      instance_id: "env-owner-id",
      source: "env",
    });
  });

  test("resolveOwner reads payload ids when env unset (source=payload)", () => {
    const got = resolveOwner({ payload: { session_id: "pay-sess" }, coordRoot: root });
    expect(got).toEqual({ instance_id: "pay-sess", source: "payload" });
  });

  test("resolveOwner payload precedence: agent_id > session_id", () => {
    const got = resolveOwner({
      payload: { agent_id: "agent-x", session_id: "sess-y" },
      coordRoot: root,
    });
    expect(got?.instance_id).toBe("agent-x");
  });

  test("resolveOwner returns null when env unset, no payload, no pid-map hit", () => {
    // empty pid-map dir + no payload → null (the test runner's pid chain has no
    // entry in this fresh tmp root)
    expect(resolveOwner({ payload: null, coordRoot: root })).toBeNull();
  });
});
