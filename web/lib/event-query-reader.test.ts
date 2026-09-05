import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  endWorkflowChildSessionV3,
  startWorkflowChildSessionV3,
} from "../../src/core/workflow/live-session-v3";
import { __resetCoordRootCache } from "./coord-reader";
import { readEventQuery } from "./event-query-reader";

const roots: string[] = [];
const previousRoot = process.env.HARNERY_COORD_ROOT;
afterEach(() => {
  if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = previousRoot;
  __resetCoordRootCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "event-query-test-"));
  roots.push(root);
  return root;
}

test("run queries follow the execution root and discover newly started children", () => {
  const root = freshRoot();
  const foreign = freshRoot();
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
  const runDir = join(root, ".harnery", "workflows", "wf-query");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), JSON.stringify({ execution: { cwd: foreign } }));
  writeFileSync(
    join(runDir, "transcript.jsonl"),
    `${JSON.stringify({ ts: new Date().toISOString(), event: "run.start", name: "query" })}\n`,
  );
  const start = (coordRoot: string, instanceId: string, runId: string) =>
    startWorkflowChildSessionV3({
      coordRoot,
      instanceId,
      runId,
      agentId: instanceId,
      sessionId: `native-${instanceId}`,
      adapter: "codex",
    });
  start(root, "local", "wf-query");
  start(foreign, "unrelated", "wf-other");
  expect(readEventQuery({ run: "wf-query", type: "session.started" }).rows).toEqual([]);
  start(foreign, "first", "wf-query");
  const first = readEventQuery({ run: "wf-query", type: "session.started" });
  expect(first.rows).toHaveLength(1);
  expect(first.meta.path.startsWith(foreign)).toBe(true);
  start(foreign, "second", "wf-query");
  const both = readEventQuery({ run: "wf-query", type: "session.started" });
  expect(both.rows).toHaveLength(2);
  expect(both.rows[1]?.event_id).toBe(first.rows[0]?.event_id);
  expect(readEventQuery({ run: "wf-query", type: "session.started", limit: 1 }).rows).toEqual(
    both.rows.slice(0, 1),
  );
  expect(
    readEventQuery({
      run: "wf-query",
      type: "session.started",
      instanceId: both.rows[1]?.instance_id,
    }).rows,
  ).toEqual(first.rows);
  expect(readEventQuery({ type: "session.started" }).rows).toHaveLength(1);
  endWorkflowChildSessionV3({
    coordRoot: foreign,
    instanceId: "first",
    runId: "wf-query",
    agentId: "first",
    sessionId: "native-first",
    adapter: "codex",
    cleanExit: true,
  });
  writeFileSync(
    join(runDir, "transcript.jsonl"),
    `${JSON.stringify({
      ts: new Date().toISOString(),
      event: "agent.end",
      id: "first",
      session_id: "native-first",
      ok: true,
    })}\n`,
    { flag: "a" },
  );
  expect(readEventQuery({ run: "wf-query", type: "session.started" }).rows).toEqual(both.rows);
});
