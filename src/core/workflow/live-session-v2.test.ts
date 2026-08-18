import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV2 } from "../events/v2/bootstrap.ts";
import { readCoordinationViewV2 } from "../events/v2/coordination-view.ts";
import { liveInstanceIdV2 } from "../events/v2/live-routing.ts";
import { readLedgerV2 } from "../events/v2/reader.ts";
import { endWorkflowChildSessionV2, startWorkflowChildSessionV2 } from "./live-session-v2.ts";

let root: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `harnery-wf-child-v2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  initializeEventLedgerV2({
    coordRoot: root,
    harneryBuild: "workflow-test",
    hostBuild: "host-test",
    configDigest: `sha256:${"0".repeat(64)}`,
    approvalRecordId: "test-workflow-v2",
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workflow child V2 lifecycle", () => {
  test("records a workflow-scoped generation and materializes only a disposable V2 cache", () => {
    const child = startWorkflowChildSessionV2({
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
      platform: "codex",
      kind: "workflow-child",
      task: "verify slice",
    });
    const generation = readCoordinationViewV2(root).instances[liveInstanceIdV2("workflow-run-a1")];
    expect(generation?.workflow_id).toStartWith("wf_");
    expect(generation?.run_id).toStartWith("run_");
    expect(generation?.phase).toBe("live");
  });

  test("records the authoritative terminal before removing the cache", () => {
    const input = {
      coordRoot: root,
      instanceId: "workflow-run-a2",
      runId: "workflow-run",
      agentId: "a2",
      adapter: "cursor",
    } as const;
    startWorkflowChildSessionV2(input);
    endWorkflowChildSessionV2({ ...input, cleanExit: true });

    expect(existsSync(join(root, ".harnery", "active", "workflow-run-a2.json"))).toBe(false);
    const events = readLedgerV2(root)
      .events.map(({ event }) => event)
      .filter((event) => event.scope.instance_id === liveInstanceIdV2("workflow-run-a2"));
    expect(events.map((event) => event.event_type)).toEqual(["session.started", "session.ended"]);
    expect(events[1]?.payload).toMatchObject({ outcome: "succeeded", authority: "native" });
  });
});
