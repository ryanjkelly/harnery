import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveName } from "../agents/state/names.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { readCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import { liveInstanceIdV3 } from "../events/v3/live-routing.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import { endWorkflowChildSessionV3, startWorkflowChildSessionV3 } from "./live-session-v3.ts";

let root: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `harnery-wf-child-v3-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "workflow-test",
    hostBuild: "host-test",
    configDigest: `sha256:${"0".repeat(64)}`,
    approvalRecordId: "test-workflow-v3",
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workflow child V3 lifecycle", () => {
  test("records a workflow-scoped generation and materializes only a disposable V3 cache", () => {
    const child = startWorkflowChildSessionV3({
      coordRoot: root,
      instanceId: "workflow-run-a1",
      runId: "workflow-run",
      agentId: "a1",
      adapter: "codex",
      label: "verify slice",
      model: "gpt-test",
    });

    expect(child).toMatchObject({
      schema_version: 2,
      instance_id: "workflow-run-a1",
      name: "Anna",
      platform: "codex",
      kind: "workflow-child",
      task: "verify slice",
    });
    const generation = readCoordinationViewV3(root).instances[liveInstanceIdV3("workflow-run-a1")];
    expect(generation?.workflow_id).toStartWith("wf_");
    expect(generation?.run_id).toStartWith("run_");
    expect(generation?.phase).toBe("live");
  });

  test("allocates canonical names instead of promoting task labels into identities", () => {
    const first = startWorkflowChildSessionV3({
      coordRoot: root,
      instanceId: "workflow-run-a1",
      runId: "workflow-run",
      agentId: "a1",
      adapter: "codex",
      label: "Re-review implementation corrections",
    });
    const second = startWorkflowChildSessionV3({
      coordRoot: root,
      instanceId: "workflow-run-a2",
      runId: "workflow-run",
      agentId: "a2",
      adapter: "codex",
      label: "Re-review integration corrections",
    });

    expect(first).toMatchObject({
      name: "Anna",
      kind: "workflow-child",
      task: "Re-review implementation corrections",
    });
    expect(second).toMatchObject({
      name: "Bob",
      kind: "workflow-child",
      task: "Re-review integration corrections",
    });
  });

  test("records the authoritative terminal before removing the cache", () => {
    const input = {
      coordRoot: root,
      instanceId: "workflow-run-a2",
      runId: "workflow-run",
      agentId: "a2",
      adapter: "cursor",
    } as const;
    startWorkflowChildSessionV3(input);
    endWorkflowChildSessionV3({ ...input, cleanExit: true });

    expect(existsSync(join(root, ".harnery", "active", "workflow-run-a2.json"))).toBe(false);
    expect(resolveName(root, "workflow-run-a2")).toEqual({
      name: "Anna",
      kind: "workflow-child",
    });
    const events = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.scope.instance_id === liveInstanceIdV3("workflow-run-a2"));
    expect(events.map((event) => event.event_type)).toEqual(["session.started", "session.ended"]);
    expect(events[1]?.payload).toMatchObject({
      outcome: "succeeded",
      authority: "approved",
      reason: "approved_explicit_end",
    });
  });
});
