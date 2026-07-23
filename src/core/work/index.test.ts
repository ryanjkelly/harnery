import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveWorkflowApproval, type Spawner, WorkflowParkedError } from "../workflow/index.ts";
import {
  acceptWorkItem,
  cancelWorkItem,
  createWorkItem,
  listWorkItems,
  readWorkItem,
  reconcileWorkItem,
  reopenWorkItem,
  runWorkItem,
} from "./index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(script = "export default async () => 'ok';\n") {
  const root = mkdtempSync(join("/tmp", "harnery-work-"));
  roots.push(root);
  const workflowPath = join(root, "workflow.mjs");
  writeFileSync(workflowPath, script);
  return { root, workflowPath };
}

const spawner: Spawner = async () => ({ ok: true, text: "ok", durationMs: 1, costUsd: 0 });

describe("durable work ledger", () => {
  test("creates private immutable intent and derives ready state", () => {
    const { root, workflowPath } = fixture();
    const record = createWorkItem({
      coordRoot: root,
      id: "work-fixture",
      title: "Ship the capability",
      objective: "Produce a verified release.",
      workflowPath,
      acceptance: ["Tests pass"],
      actor: "tester",
    });

    expect(record.projection.state).toBe("ready");
    expect(record.projection.next_action).toBe("run");
    expect(record.events.map((event) => event.event)).toEqual(["work.created"]);
    expect(
      statSync(join(root, ".harnery", "work", "work-fixture", "intent.json")).mode & 0o777,
    ).toBe(0o600);
    expect(
      statSync(join(root, ".harnery", "work", "work-fixture", "events.jsonl")).mode & 0o777,
    ).toBe(0o600);
    expect(() =>
      createWorkItem({
        coordRoot: root,
        id: "work-fixture",
        title: "Duplicate",
        objective: "Must fail.",
        workflowPath,
      }),
    ).toThrow();
  });

  test("derives dependency readiness without mutating the dependent", () => {
    const { root, workflowPath } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "base",
      title: "Base",
      objective: "Base work",
      workflowPath,
    });
    const dependent = createWorkItem({
      coordRoot: root,
      id: "dependent",
      title: "Dependent",
      objective: "Wait for base",
      workflowPath,
      dependencies: ["base"],
    });
    expect(dependent.projection.state).toBe("waiting");
    expect(dependent.projection.unresolved_dependencies).toEqual(["base"]);
    expect(() =>
      createWorkItem({
        coordRoot: root,
        id: "missing-dependency",
        title: "Missing",
        objective: "Invalid dependency",
        workflowPath,
        dependencies: ["not-there"],
      }),
    ).toThrow(/does not exist/);
  });

  test("links an attempt before execution and requires explicit acceptance", async () => {
    const { root, workflowPath } = fixture(`
      export const meta = { name: "proof", acceptance: [{ id: "tests", statement: "Tests pass" }] };
      export default async (ctx) => {
        ctx.evidence({ kind: "test", status: "passed", label: "suite", acceptanceIds: ["tests"] });
        return ctx.work;
      };
    `);
    createWorkItem({
      coordRoot: root,
      id: "ship",
      title: "Ship",
      objective: "Ship safely",
      acceptance: ["The focused tests pass"],
      workflowPath,
    });
    const report = await runWorkItem({
      coordRoot: root,
      workId: "ship",
      engine: { spawners: { "claude-code": spawner } },
      actor: "tester",
    });
    expect(report.workItemId).toBe("ship");
    const record = readWorkItem(root, "ship");
    expect(record.projection.state).toBe("in_review");
    expect(record.projection.attempts_used).toBe(1);
    expect(record.projection.attempts[0]?.run_id).toBe(report.runId);
    const manifest = JSON.parse(
      readFileSync(join(root, ".harnery", "workflows", report.runId, "run.json"), "utf8"),
    );
    const proof = JSON.parse(
      readFileSync(join(root, ".harnery", "workflows", report.runId, "proof.json"), "utf8"),
    );
    expect(manifest.work_item_id).toBe("ship");
    expect(proof.run.work_item_id).toBe("ship");
    expect(report.result).toEqual({
      schema_version: 1,
      id: "ship",
      title: "Ship",
      objective: "Ship safely",
      acceptance: ["The focused tests pass"],
    });
    expect(manifest.work_context).toEqual(report.result);
    expect(proof.run.work_context).toEqual(report.result);

    const accepted = acceptWorkItem(root, "ship", { actor: "reviewer", reason: "proof reviewed" });
    expect(accepted.projection.state).toBe("succeeded");
    expect(accepted.projection.next_action).toBe("none");
  });

  test("failed proof blocks and retry is deliberate and bounded", async () => {
    const { root, workflowPath } = fixture(`
      export default async () => { throw new Error("boom"); };
    `);
    createWorkItem({
      coordRoot: root,
      id: "retryable",
      title: "Retryable",
      objective: "Fail visibly",
      workflowPath,
      maxAttempts: 2,
    });
    await expect(
      runWorkItem({ coordRoot: root, workId: "retryable", engine: { spawners: {} } }),
    ).rejects.toThrow(/boom/);
    expect(readWorkItem(root, "retryable").projection.state).toBe("blocked");
    await expect(
      runWorkItem({ coordRoot: root, workId: "retryable", engine: { spawners: {} } }),
    ).rejects.toThrow(/explicit retry/);
    await expect(
      runWorkItem({
        coordRoot: root,
        workId: "retryable",
        retry: true,
        engine: { spawners: {} },
      }),
    ).rejects.toThrow(/boom/);
    const exhausted = readWorkItem(root, "retryable");
    expect(exhausted.projection.attempts_used).toBe(2);
    expect(exhausted.projection.next_action).toBe("none");
    await expect(
      runWorkItem({
        coordRoot: root,
        workId: "retryable",
        retry: true,
        engine: { spawners: {} },
      }),
    ).rejects.toThrow(/exhausted/);
  });

  test("fails closed when proof work context no longer matches its manifest", async () => {
    const { root, workflowPath } = fixture(`
      export default async ({ work }) => work.objective;
    `);
    createWorkItem({
      coordRoot: root,
      id: "tamper-proof",
      title: "Tamper proof",
      objective: "Preserve the exact assignment",
      workflowPath,
    });
    const report = await runWorkItem({
      coordRoot: root,
      workId: "tamper-proof",
      engine: { spawners: {} },
    });
    const proof = JSON.parse(readFileSync(report.proofPath, "utf8"));
    proof.run.work_context.objective = "Changed after execution";
    writeFileSync(report.proofPath, `${JSON.stringify(proof)}\n`, "utf8");
    expect(() => readWorkItem(root, "tamper-proof")).toThrow(
      /work context does not match its run manifest/,
    );
  });

  test("records the attempt before workflow import and surfaces an import crash", async () => {
    const { root, workflowPath } = fixture(`throw new Error("top-level crash");\n`);
    createWorkItem({
      coordRoot: root,
      id: "import-crash",
      title: "Import crash",
      objective: "Keep the objective discoverable",
      workflowPath,
    });
    await expect(
      runWorkItem({ coordRoot: root, workId: "import-crash", engine: { spawners: {} } }),
    ).rejects.toThrow(/top-level crash/);
    const record = readWorkItem(root, "import-crash");
    expect(record.projection.state).toBe("blocked");
    expect(record.projection.attempts_used).toBe(1);
    expect(record.projection.attempts[0]?.status).toBe("lost");
  });

  test("a parked run resumes as the same attempt after explicit approval", async () => {
    const { root, workflowPath } = fixture(`
      export default async (ctx) => ctx.agent("do the work: " + ctx.work.objective);
    `);
    let spawns = 0;
    const prompts: string[] = [];
    const countingSpawner: Spawner = async (request) => {
      spawns++;
      prompts.push(request.prompt);
      return { ok: true, text: "done", durationMs: 1 };
    };
    createWorkItem({
      coordRoot: root,
      id: "parked",
      title: "Parked",
      objective: "Wait safely",
      workflowPath,
    });
    let parked: WorkflowParkedError | undefined;
    try {
      await runWorkItem({
        coordRoot: root,
        workId: "parked",
        engine: {
          spawners: { "claude-code": countingSpawner },
          policy: { name: "approval required", network: "ask" },
          networkAccess: "enabled",
          approvalMode: "park",
        },
      });
    } catch (error) {
      if (error instanceof WorkflowParkedError) parked = error;
      else throw error;
    }
    expect(parked).toBeDefined();
    expect(spawns).toBe(0);
    const pending = readWorkItem(root, "parked");
    expect(pending.projection.state).toBe("awaiting_approval");
    expect(pending.projection.attempts_used).toBe(1);
    const originalRunId = pending.projection.latest_run_id;

    resolveWorkflowApproval({
      coordRoot: root,
      approvalId: parked!.approvalId,
      verdict: "allow",
      actor: "reviewer",
    });
    expect(readWorkItem(root, "parked").projection.next_action).toBe("resume");
    const report = await runWorkItem({
      coordRoot: root,
      workId: "parked",
      engine: { spawners: { "claude-code": countingSpawner } },
    });
    expect(report.runId).toBe(originalRunId!);
    expect(spawns).toBe(1);
    expect(prompts).toEqual(["do the work: Wait safely"]);
    expect(readWorkItem(root, "parked").projection.attempts_used).toBe(1);
  });

  test("reconciliation is a no-op over unchanged evidence", () => {
    const { root, workflowPath } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "stable",
      title: "Stable",
      objective: "Stay stable",
      workflowPath,
    });
    const first = reconcileWorkItem(root, "stable", "tester");
    const firstBytes = readFileSync(join(root, ".harnery", "work", "stable", "events.jsonl"));
    const second = reconcileWorkItem(root, "stable", "tester");
    const secondBytes = readFileSync(join(root, ".harnery", "work", "stable", "events.jsonl"));
    expect(first.events.length).toBe(2);
    expect(second.events.length).toBe(2);
    expect(secondBytes.equals(firstBytes)).toBe(true);
  });

  test("governance transitions are explicit and history remains append-only", () => {
    const { root, workflowPath } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "governed",
      title: "Governed",
      objective: "Control closure",
      workflowPath,
    });
    const cancelled = cancelWorkItem(root, "governed", { actor: "operator", reason: "not needed" });
    expect(cancelled.projection.state).toBe("cancelled");
    const reopened = reopenWorkItem(root, "governed", {
      actor: "operator",
      reason: "needed again",
    });
    expect(reopened.projection.state).toBe("ready");
    expect(reopened.events.some((event) => event.event === "work.cancelled")).toBe(true);
    expect(reopened.events.some((event) => event.event === "work.reopened")).toBe(true);
    expect(listWorkItems(root).map((record) => record.intent.id)).toEqual(["governed"]);
  });

  test("refuses workflow drift instead of running changed intent", async () => {
    const { root, workflowPath } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "drift",
      title: "Drift",
      objective: "Bind script",
      workflowPath,
    });
    writeFileSync(workflowPath, "export default async () => 'changed';\n");
    await expect(
      runWorkItem({ coordRoot: root, workId: "drift", engine: { spawners: {} } }),
    ).rejects.toThrow(/changed since/);
    expect(readWorkItem(root, "drift").projection.attempts_used).toBe(0);
  });

  test("fails closed on a truncated append-only event", () => {
    const { root, workflowPath } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "truncated",
      title: "Truncated",
      objective: "Fail closed",
      workflowPath,
    });
    const path = join(root, ".harnery", "work", "truncated", "events.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8")}{"event":`);
    expect(() => readWorkItem(root, "truncated")).toThrow(/truncated final line/);
  });

  test("refuses proof from a workflow linked to another work item", async () => {
    const { root, workflowPath } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "owner",
      title: "Owner",
      objective: "Own proof",
      workflowPath,
    });
    const report = await runWorkItem({
      coordRoot: root,
      workId: "owner",
      engine: { spawners: {} },
    });
    createWorkItem({
      coordRoot: root,
      id: "victim",
      title: "Victim",
      objective: "Reject foreign proof",
      workflowPath,
    });
    appendFileSync(
      join(root, ".harnery", "work", "victim", "events.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        work_id: "victim",
        seq: 2,
        ts: new Date().toISOString(),
        event: "attempt.started",
        actor: "attacker",
        run_id: report.runId,
        attempt: 1,
      })}\n`,
    );
    expect(() => readWorkItem(root, "victim")).toThrow(/does not belong/);
  });
});
