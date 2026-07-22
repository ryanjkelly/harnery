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
});
