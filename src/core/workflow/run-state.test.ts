import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireWorkflowResumeLease,
  readWorkflowRunManifest,
  type WorkflowRunManifest,
  writeWorkflowRunManifest,
} from "./run-state.ts";

let root: string;

beforeEach(() => {
  root = join("/tmp", `workflow-run-state-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, ".harnery"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workflow run state", () => {
  function fixtureManifest(): WorkflowRunManifest {
    return {
      schema_version: 2,
      run_id: "wf-observation",
      name: "observation",
      started_at: "2026-10-16T12:00:00.000Z",
      script: { path: join(root, "workflow.mjs"), sha256: "a".repeat(64) },
      repository_before: { cwd: root, observation: "ok", dirty_paths: ["checkpoint.txt"] },
      execution: {
        cwd: root,
        default_adapter: "codex",
        max_agents: 1,
        concurrency: 1,
        subscription_only: true,
        allow_api_billing: false,
        approval_mode: "deny",
        approval_addressee: "operator",
        isolation: "shared",
        network_access: "unknown",
      },
    };
  }

  test("pre-observation manifests read as unavailable without losing checkpoint paths", () => {
    const path = writeWorkflowRunManifest({ coordRoot: root, manifest: fixtureManifest() });
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    delete persisted.repository_before.observation;
    writeFileSync(path, `${JSON.stringify(persisted)}\n`);
    expect(readWorkflowRunManifest(root, "wf-observation").repository_before).toEqual({
      cwd: root,
      observation: "unavailable",
      observation_detail: "No repository observation was recorded.",
      dirty_paths: ["checkpoint.txt"],
    });
  });

  for (const observation of ["ok", "partial", "unavailable"] as const) {
    test(`preserves a valid ${observation} observation and its bounded reason`, () => {
      const manifest = fixtureManifest();
      manifest.repository_before.observation = observation;
      manifest.repository_before.observation_detail = "failed";
      writeWorkflowRunManifest({ coordRoot: root, manifest });
      expect(readWorkflowRunManifest(root, manifest.run_id).repository_before).toEqual(
        manifest.repository_before,
      );
    });
  }

  test("rejects invalid observation states and unbounded details", () => {
    const path = writeWorkflowRunManifest({ coordRoot: root, manifest: fixtureManifest() });
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    persisted.repository_before.observation = "clean";
    writeFileSync(path, `${JSON.stringify(persisted)}\n`);
    expect(() => readWorkflowRunManifest(root, "wf-observation")).toThrow(/mismatched schema/);
    persisted.repository_before.observation = "unavailable";
    persisted.repository_before.observation_detail = "x".repeat(501);
    writeFileSync(path, `${JSON.stringify(persisted)}\n`);
    expect(() => readWorkflowRunManifest(root, "wf-observation")).toThrow(/mismatched schema/);
  });
  test("allows only one resume lease and releases it for the next attempt", () => {
    const release = acquireWorkflowResumeLease(root, "wf-fixture");
    expect(() => acquireWorkflowResumeLease(root, "wf-fixture")).toThrow(
      /resume lease is already held/,
    );
    release();
    const releaseAgain = acquireWorkflowResumeLease(root, "wf-fixture");
    releaseAgain();
  });

  for (const owner of [
    "{invalid-json",
    JSON.stringify({
      pid: 2_147_483_647,
      host: "remote-host",
      created_at: "2000-01-01T00:00:00.000Z",
    }),
    JSON.stringify({ pid: 2_147_483_647, host: "", created_at: "invalid-time" }),
  ]) {
    test(`an existing resume lock is never replaced: ${owner}`, () => {
      const path = join(root, ".harnery", "workflows", "wf-held", "resume.lock");
      mkdirSync(join(root, ".harnery", "workflows", "wf-held"), { recursive: true });
      writeFileSync(path, owner);
      expect(() => acquireWorkflowResumeLease(root, "wf-held")).toThrow(
        /resume lease is already held/,
      );
      expect(readFileSync(path, "utf8")).toBe(owner);
    });
  }

  test("an old release cannot remove a later lease from the same process", () => {
    const release = acquireWorkflowResumeLease(root, "wf-owner");
    release();
    const releaseAgain = acquireWorkflowResumeLease(root, "wf-owner");
    const path = join(root, ".harnery", "workflows", "wf-owner", "resume.lock");
    const owner = readFileSync(path, "utf8");
    release();
    expect(readFileSync(path, "utf8")).toBe(owner);
    releaseAgain();
  });

  test("rejects a persisted manifest with unsafe execution bounds", () => {
    const path = writeWorkflowRunManifest({
      coordRoot: root,
      manifest: {
        schema_version: 2,
        run_id: "wf-fixture",
        name: "fixture",
        started_at: "2026-07-21T12:00:00.000Z",
        script: { path: join(root, "workflow.mjs"), sha256: "a".repeat(64) },
        repository_before: { cwd: root, observation: "ok", dirty_paths: [] },
        execution: {
          cwd: root,
          default_adapter: "claude-code",
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
        schema_version: 2,
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
        repository_before: { cwd: root, observation: "ok", dirty_paths: [] },
        execution: {
          cwd: root,
          default_adapter: "codex",
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
