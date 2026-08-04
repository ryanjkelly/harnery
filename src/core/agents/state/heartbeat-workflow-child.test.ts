/**
 * Locks engine-side workflow-child registration.
 *
 * Children used to be visible only if their adapter fired Harnery's hooks.
 * Headless `codex exec` fires none, so codex children never wrote a heartbeat:
 * they were absent from `harn agents list` and rendered "no live session" on
 * the run page for the entire duration of a stage, while actively editing the
 * repo. These tests pin the properties the run page depends on, so a future
 * refactor cannot quietly make coordination visibility a property of the
 * vendor CLI again.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killHeartbeat, registerWorkflowChild } from "./heartbeat-writer.ts";

let root: string;

const hbPath = (instanceId: string): string =>
  join(root, ".harnery", "active", `${instanceId}.json`);

const readHb = (instanceId: string): Record<string, unknown> =>
  JSON.parse(readFileSync(hbPath(instanceId), "utf8")) as Record<string, unknown>;

beforeEach(() => {
  root = join(
    tmpdir(),
    `harnery-wf-child-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("registerWorkflowChild", () => {
  test("writes the two fields the run-page reader filters on", () => {
    // readWorkflowChildHeartbeats skips any heartbeat missing either of these,
    // so a child without both is invisible no matter what else it records.
    registerWorkflowChild(root, {
      instanceId: "wf-1-a1",
      runId: "wf-1",
      agentId: "a1",
      adapter: "codex",
      label: "verify:some-slice",
    });

    const hb = readHb("wf-1-a1");
    expect(hb.workflow_run_id).toBe("wf-1");
    expect(hb.session_id).toBeTruthy();
    expect(hb.workflow_agent_id).toBe("a1");
  });

  test("registers a codex child, the adapter that fires no hooks", () => {
    registerWorkflowChild(root, {
      instanceId: "wf-2-a1",
      runId: "wf-2",
      agentId: "a1",
      adapter: "codex",
      label: "verify:x",
    });

    const hb = readHb("wf-2-a1");
    expect(hb.platform).toBe("codex");
    expect(hb.task).toBe("verify:x");
    expect(hb.name).toBe("verify:x");
    expect(hb.kind).toBe("workflow-child");
  });

  test("is idempotent and preserves started_at and hook-recorded claims", () => {
    registerWorkflowChild(root, {
      instanceId: "wf-3-a1",
      runId: "wf-3",
      agentId: "a1",
      adapter: "cursor",
      label: "implement:x",
    });
    const first = readHb("wf-3-a1");

    // Simulate a hook enriching the same file mid-stage.
    const enriched = { ...first, files_touched: ["theme/foo.liquid"], last_tool: "Edit" };
    Bun.write(hbPath("wf-3-a1"), JSON.stringify(enriched, null, 2));

    registerWorkflowChild(root, {
      instanceId: "wf-3-a1",
      runId: "wf-3",
      agentId: "a1",
      adapter: "cursor",
      label: "implement:x",
    });

    const second = readHb("wf-3-a1");
    expect(second.started_at).toBe(first.started_at as string);
    expect(second.files_touched).toEqual(["theme/foo.liquid"]);
  });

  test("falls back to instanceId for session_id so the reader never skips it", () => {
    // The adapter mints the real session id and only reports it at agent.end,
    // so at spawn time there is nothing else to use.
    registerWorkflowChild(root, { instanceId: "wf-4-a1", runId: "wf-4", agentId: "a1" });
    expect(readHb("wf-4-a1").session_id).toBe("wf-4-a1");
  });

  test("killHeartbeat deregisters, so a dead child cannot read as live forever", () => {
    registerWorkflowChild(root, { instanceId: "wf-5-a1", runId: "wf-5", agentId: "a1" });
    expect(existsSync(hbPath("wf-5-a1"))).toBe(true);

    expect(killHeartbeat(root, "wf-5-a1")).toBe(true);
    expect(existsSync(hbPath("wf-5-a1"))).toBe(false);
  });
});
