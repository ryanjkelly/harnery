import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireWorkflowResumeLease,
  readWorkflowRunManifest,
  writeWorkflowRunManifest,
} from "./run-state.ts";

let root: string;

beforeEach(() => {
  root = join("/tmp", `workflow-run-state-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, ".harnery"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workflow run state", () => {
  test("allows only one resume lease and releases it for the next attempt", () => {
    const release = acquireWorkflowResumeLease(root, "wf-fixture");
    expect(() => acquireWorkflowResumeLease(root, "wf-fixture")).toThrow(/already being resumed/);
    release();
    const releaseAgain = acquireWorkflowResumeLease(root, "wf-fixture");
    releaseAgain();
  });

  test("rejects a persisted manifest with unsafe execution bounds", () => {
    const path = writeWorkflowRunManifest({
      coordRoot: root,
      manifest: {
        schema_version: 1,
        run_id: "wf-fixture",
        name: "fixture",
        started_at: "2026-07-21T12:00:00.000Z",
        script: { path: join(root, "workflow.mjs"), sha256: "a".repeat(64) },
        repository_before: { cwd: root, dirty_paths: [] },
        execution: {
          cwd: root,
          default_harness: "claude-code",
          max_agents: 5,
          concurrency: 2,
          subscription_only: true,
          allow_api_billing: false,
          approval_mode: "park",
          approval_addressee: "operator",
          isolation: "shared",
          network_access: "enabled",
        },
      },
    });
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    persisted.execution.concurrency = 0;
    writeFileSync(path, `${JSON.stringify(persisted)}\n`, "utf8");
    expect(() => readWorkflowRunManifest(root, "wf-fixture")).toThrow(/mismatched schema/);
  });

  test("requires canonical work context paired with its work item id", () => {
    const path = writeWorkflowRunManifest({
      coordRoot: root,
      manifest: {
        schema_version: 1,
        run_id: "wf-work-context",
        work_item_id: "work-a",
        work_context: {
          schema_version: 1,
          id: "work-a",
          title: "Work A",
          objective: "Complete A",
          acceptance: ["Tests pass"],
        },
        attempt_context: {
          schema_version: 1,
          number: 1,
          trigger: "initial",
        },
        name: "fixture",
        started_at: "2026-07-23T05:00:00.000Z",
        script: { path: join(root, "workflow.mjs"), sha256: "a".repeat(64) },
        repository_before: { cwd: root, dirty_paths: [] },
        execution: {
          cwd: root,
          default_harness: "codex",
          max_agents: 1,
          concurrency: 1,
          subscription_only: true,
          allow_api_billing: false,
          approval_mode: "deny",
          approval_addressee: "operator",
          isolation: "shared",
          network_access: "unknown",
        },
      },
    });
    expect(readWorkflowRunManifest(root, "wf-work-context").work_context?.objective).toBe(
      "Complete A",
    );
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    persisted.attempt_context = { schema_version: 1, number: 2, trigger: "retry" };
    writeFileSync(path, `${JSON.stringify(persisted)}\n`, "utf8");
    expect(() => readWorkflowRunManifest(root, "wf-work-context")).toThrow(/mismatched schema/);
    persisted.attempt_context = { schema_version: 1, number: 1, trigger: "initial" };
    persisted.work_context.id = "work-b";
    writeFileSync(path, `${JSON.stringify(persisted)}\n`, "utf8");
    expect(() => readWorkflowRunManifest(root, "wf-work-context")).toThrow(/mismatched schema/);
  });
});
