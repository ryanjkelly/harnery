import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { stableDigest } from "./durable-record.ts";
import * as recoveryAudit from "./recovery-audit.ts";
import * as runState from "./run-state.ts";
import {
  acquireWorkflowResumeLease,
  readWorkflowRunManifest,
  recoverWorkflowResumeLease,
  type WorkflowRunManifest,
  writeWorkflowRunManifest,
} from "./run-state.ts";
import { acquireNoClobberLease } from "./workspaces/leases.ts";

let root: string;

beforeEach(() => {
  root = join("/tmp", `workflow-run-state-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, ".harnery"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function abandonedLock(runId = "wf-abandoned") {
  const path = join(root, ".harnery", "workflows", runId, "resume.lock");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      owner_id: "dead-owner",
      pid: 2_147_483_647,
      host: hostname(),
      created_at: "2000-01-01T00:00:00.000Z",
    }),
  );
  const preview = recoverWorkflowResumeLease(root, runId, {});
  return {
    path,
    runId,
    options: {
      yes: true,
      lockSha256: preview.lock_sha256!,
      actor: "operator",
      reason: "Owner exited.",
    },
  };
}

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

  test("a live owner releases its exact lock despite a competing mutation gate", () => {
    const release = acquireWorkflowResumeLease(root, "wf-release");
    const directory = join(root, ".harnery", "workflows", "wf-release");
    const gate = acquireNoClobberLease({
      path: join(directory, "resume-mutation.lease"),
      scope: "workflow-resume-mutation",
      authoritySha256: stableDigest({ run_id: "wf-release", lock: "resume.lock" }),
      staleAfterMs: 300_000,
    });
    try {
      release();
      expect(existsSync(join(directory, "resume.lock"))).toBe(false);
    } finally {
      gate.release();
    }
    acquireWorkflowResumeLease(root, "wf-release")();
  });

  test("release preserves a replacement inode even with identical owner bytes", () => {
    const release = acquireWorkflowResumeLease(root, "wf-replaced-inode");
    const path = join(root, ".harnery", "workflows", "wf-replaced-inode", "resume.lock");
    const bytes = readFileSync(path, "utf8");
    renameSync(path, `${path}.retained`);
    writeFileSync(path, bytes);
    release();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  test("confirmed recovery retires an exact abandoned resume lock", () => {
    const path = join(root, ".harnery", "workflows", "wf-abandoned", "resume.lock");
    mkdirSync(join(root, ".harnery", "workflows", "wf-abandoned"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        owner_id: "dead-owner",
        pid: 2_147_483_647,
        host: hostname(),
        created_at: "2000-01-01T00:00:00.000Z",
      }),
    );
    const recover = Reflect.get(runState, "recoverWorkflowResumeLease");
    expect(typeof recover).toBe("function");
    const preview = recover(root, "wf-abandoned", {});
    expect(preview).toMatchObject({ action: "preview", owner_state: "dead" });
    expect(existsSync(path)).toBe(true);
    expect(
      recover(root, "wf-abandoned", {
        yes: true,
        lockSha256: preview.lock_sha256!,
        actor: "operator",
        reason: "Owner exited before release.",
      }).action,
    ).toBe("unlocked");
    expect(existsSync(path)).toBe(false);
    acquireWorkflowResumeLease(root, "wf-abandoned")();
  });

  for (const owner of [
    "corrupt",
    JSON.stringify({ pid: process.pid, host: hostname(), created_at: new Date().toISOString() }),
    JSON.stringify({
      pid: 2_147_483_647,
      host: "foreign-host",
      created_at: new Date().toISOString(),
    }),
  ]) {
    test(`audited recovery preserves a live or unproven owner ${owner}`, () => {
      const { path, runId, options } = abandonedLock();
      writeFileSync(path, owner);
      const preview = recoverWorkflowResumeLease(root, runId, {});
      expect(() =>
        recoverWorkflowResumeLease(root, runId, { ...options, lockSha256: preview.lock_sha256! }),
      ).toThrow("unlock refused");
      expect(readFileSync(path, "utf8")).toBe(owner);
      expect(recoveryAudit.readWorkflowRecoveryLedger(root, runId)).toEqual([]);
    });
  }

  test("preview ignores confirmation metadata and leaves the lock and audit unchanged", () => {
    const { path, runId } = abandonedLock();
    const before = readFileSync(path, "utf8");
    expect(
      recoverWorkflowResumeLease(root, runId, { actor: "operator", reason: "Preview only." })
        .action,
    ).toBe("preview");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(recoveryAudit.readWorkflowRecoveryLedger(root, runId)).toEqual([]);
  });

  test("absent lock and missing confirmation authority cannot produce unlock success", () => {
    expect(recoverWorkflowResumeLease(root, "wf-absent", {})).toMatchObject({
      action: "preview",
      owner_state: "absent",
      lock_sha256: null,
    });
    expect(() => recoverWorkflowResumeLease(root, "wf-absent", { yes: true })).toThrow(
      "owner is absent",
    );
    const { path, runId, options } = abandonedLock();
    expect(() => recoverWorkflowResumeLease(root, runId, { ...options, actor: "" })).toThrow(
      "nonempty actor",
    );
    expect(() =>
      recoverWorkflowResumeLease(root, runId, { ...options, lockSha256: undefined }),
    ).toThrow("exact current preview digest");
    expect(existsSync(path)).toBe(true);
    expect(recoveryAudit.readWorkflowRecoveryLedger(root, runId)).toEqual([]);
  });

  test("a changed lock and a held mutation lease both refuse exact unlock", () => {
    const { path, runId, options } = abandonedLock();
    const lease = acquireNoClobberLease({
      path: join(path, "..", "resume-mutation.lease"),
      scope: "workflow-resume-mutation",
      authoritySha256: stableDigest({ run_id: runId, lock: "resume.lock" }),
      staleAfterMs: 300_000,
    });
    try {
      expect(() => recoverWorkflowResumeLease(root, runId, options)).toThrow(
        "lease workflow-resume-mutation",
      );
    } finally {
      lease.release();
    }
    writeFileSync(path, `${readFileSync(path, "utf8")} `);
    expect(() => recoverWorkflowResumeLease(root, runId, options)).toThrow(
      "exact current preview digest",
    );
    expect(existsSync(path)).toBe(true);
  });

  test("unlock refuses an identical-byte replacement inode from its preview", () => {
    const { path, runId, options } = abandonedLock();
    const bytes = readFileSync(path, "utf8");
    renameSync(path, `${path}.retained`);
    writeFileSync(path, bytes);
    expect(() => recoverWorkflowResumeLease(root, runId, options)).toThrow(
      "exact current preview digest",
    );
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  test("mismatched stale mutation authority cannot retire the resume lock", () => {
    const { path, runId, options } = abandonedLock();
    const bytes = readFileSync(path, "utf8");
    const old = acquireNoClobberLease({
      path: join(path, "..", "resume-mutation.lease"),
      scope: "workflow-resume-mutation",
      authoritySha256: "0".repeat(64),
      staleAfterMs: 300_000,
      now: () => 1_000,
      pid: 2_147_483_647,
    });
    expect(() => recoverWorkflowResumeLease(root, runId, options)).toThrow("mismatched authority");
    expect(readFileSync(path, "utf8")).toBe(bytes);
    old.release();
  });

  test("audit write failure leaves the abandoned lock unchanged", () => {
    const { path, runId, options } = abandonedLock();
    writeFileSync(join(path, "..", "recovery"), "not a directory");
    const before = readFileSync(path, "utf8");
    expect(() => recoverWorkflowResumeLease(root, runId, options)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("replacement after durable intent survives and leaves recovery unknown", () => {
    const { path, runId, options } = abandonedLock();
    const begin = recoveryAudit.beginWorkflowRecovery;
    const replacement = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      created_at: new Date().toISOString(),
    });
    const interception = spyOn(recoveryAudit, "beginWorkflowRecovery").mockImplementation(
      (coordRoot, input) => {
        const audit = begin(coordRoot, input);
        writeFileSync(path, replacement);
        return audit;
      },
    );
    try {
      expect(() => recoverWorkflowResumeLease(root, runId, options)).toThrow("authority changed");
      expect(readFileSync(path, "utf8")).toBe(replacement);
      expect(recoveryAudit.readWorkflowRecoveryLedger(root, runId)[0]?.outcome).toBe("unknown");
    } finally {
      interception.mockRestore();
    }
  });

  test("failure after unlink cannot claim completed recovery", () => {
    const { path, runId, options } = abandonedLock();
    const begin = recoveryAudit.beginWorkflowRecovery;
    const interception = spyOn(recoveryAudit, "beginWorkflowRecovery").mockImplementation(
      (coordRoot, input) => {
        const audit = begin(coordRoot, input);
        return {
          ...audit,
          complete() {
            throw new Error("interrupted after effect");
          },
        };
      },
    );
    try {
      expect(() => recoverWorkflowResumeLease(root, runId, options)).toThrow(
        "interrupted after effect",
      );
      expect(existsSync(path)).toBe(false);
      expect(recoveryAudit.readWorkflowRecoveryLedger(root, runId)[0]?.outcome).toBe("unknown");
    } finally {
      interception.mockRestore();
    }
  });

  test("an inconclusive owner probe refuses recovery without recording an action", () => {
    const { path, runId, options } = abandonedLock();
    const probe = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    try {
      expect(() => recoverWorkflowResumeLease(root, runId, options)).toThrow("owner is unknown");
      expect(existsSync(path)).toBe(true);
      expect(recoveryAudit.readWorkflowRecoveryLedger(root, runId)).toEqual([]);
    } finally {
      probe.mockRestore();
    }
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
