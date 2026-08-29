import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  resolveWorkflowApproval,
  type Spawner,
  type SpawnRequest,
  WorkflowParkedError,
} from "../workflow/index.ts";
import { WORKFLOW_TRANSCRIPT_EVENT_BYTES } from "../workflow/transcript.ts";
import {
  acceptWorkItem,
  cancelWorkItem,
  createWorkItem,
  listWorkItems,
  listWorkItemsWithWarnings,
  openOperatorFindings,
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

  test("work-set scans skip unreadable records and keep single-item reads strict", () => {
    const { root, workflowPath } = fixture();
    for (const id of ["work-readable", "work-poisoned"]) {
      createWorkItem({
        coordRoot: root,
        id,
        title: id,
        objective: "Keep readable work available",
        workflowPath,
      });
    }
    const poisonedPath = join(root, ".harnery", "work", "work-poisoned", "intent.json");
    const poisoned = JSON.parse(readFileSync(poisonedPath, "utf8")) as Record<string, unknown>;
    poisoned.schema_version = 1;
    writeFileSync(poisonedPath, `${JSON.stringify(poisoned, null, 2)}\n`);

    expect(() => readWorkItem(root, "work-poisoned")).toThrow(
      "work intent work-poisoned has an unsupported or mismatched schema",
    );
    expect(listWorkItems(root).map((record) => record.intent.id)).toEqual(["work-readable"]);
    expect(listWorkItemsWithWarnings(root)).toMatchObject({
      records: [{ intent: { id: "work-readable" } }],
      warnings: [
        {
          work_id: "work-poisoned",
          reason: "work intent work-poisoned has an unsupported or mismatched schema",
        },
      ],
    });
  });

  test("work-set scans isolate a recorded legacy run-manifest shape", async () => {
    const { root, workflowPath } = fixture();
    for (const id of ["work-readable-run", "work-legacy-run"]) {
      createWorkItem({
        coordRoot: root,
        id,
        title: id,
        objective: "Keep readable work available",
        workflowPath,
      });
    }
    const report = await runWorkItem({
      coordRoot: root,
      workId: "work-legacy-run",
      engine: {
        spawners: {},
        specialists: {
          reviewer: {
            instructions: "Review the bounded result",
            adapter: "cursor",
            effort: "high",
          },
        },
      },
    });
    const manifestPath = join(root, ".harnery", "workflows", report.runId, "run.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      execution: Record<string, unknown>;
    };

    // This is the persisted pre-adapter vocabulary observed in an unreadable
    // run: default_harness plus role-level harness, timeoutMs, and maxTurns.
    const execution = manifest.execution;
    execution.default_harness = execution.default_adapter;
    delete execution.default_adapter;
    const specialists = execution.specialists as Record<string, Record<string, unknown>>;
    for (const profile of Object.values(specialists)) {
      profile.harness = profile.adapter;
      delete profile.adapter;
      profile.timeoutMs = 1_800_000;
      profile.maxTurns = 24;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => readWorkItem(root, "work-legacy-run")).toThrow(
      /workflow run manifest .* has an unsupported or mismatched schema/,
    );
    expect(listWorkItems(root).map((record) => record.intent.id)).toEqual(["work-readable-run"]);
    expect(listWorkItemsWithWarnings(root)).toMatchObject({
      records: [{ intent: { id: "work-readable-run" } }],
      warnings: [
        {
          work_id: "work-legacy-run",
          reason: expect.stringMatching(
            /workflow run manifest .* has an unsupported or mismatched schema/,
          ),
        },
      ],
    });
  });

  test("run-manifest identity stays strict for the operated work item", async () => {
    const { root, workflowPath } = fixture();
    for (const id of ["manifest-owner-mismatch", "manifest-context-mismatch"]) {
      createWorkItem({
        coordRoot: root,
        id,
        title: id,
        objective: `Preserve ${id}`,
        workflowPath,
      });
    }
    const ownerReport = await runWorkItem({
      coordRoot: root,
      workId: "manifest-owner-mismatch",
      engine: { spawners: {} },
    });
    const ownerPath = join(root, ".harnery", "workflows", ownerReport.runId, "run.json");
    const ownerManifest = JSON.parse(readFileSync(ownerPath, "utf8"));
    ownerManifest.work_item_id = "different-owner";
    ownerManifest.work_context.id = "different-owner";
    writeFileSync(ownerPath, `${JSON.stringify(ownerManifest, null, 2)}\n`);
    expect(() => readWorkItem(root, "manifest-owner-mismatch")).toThrow(
      /does not belong to work item manifest-owner-mismatch/,
    );

    const contextReport = await runWorkItem({
      coordRoot: root,
      workId: "manifest-context-mismatch",
      engine: { spawners: {} },
    });
    const contextPath = join(root, ".harnery", "workflows", contextReport.runId, "run.json");
    const contextManifest = JSON.parse(readFileSync(contextPath, "utf8"));
    contextManifest.work_context.objective = "Changed after execution";
    writeFileSync(contextPath, `${JSON.stringify(contextManifest, null, 2)}\n`);
    expect(() => readWorkItem(root, "manifest-context-mismatch")).toThrow(
      /work context does not match work item manifest-context-mismatch/,
    );
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

  test("a retry receives the prior terminal evidence as frozen typed context", async () => {
    const { root, workflowPath } = fixture(`
      export const meta = {
        name: "retry-context",
        acceptance: [{ id: "release", statement: "Release exists" }],
      };
      export default async (ctx) => {
        if (ctx.attempt.trigger === "retry") {
          ctx.evidence({
            kind: "artifact",
            status: "passed",
            label: "published release",
            acceptanceIds: ["release"],
          });
        }
        return ctx.attempt;
      };
    `);
    createWorkItem({
      coordRoot: root,
      id: "contextual-retry",
      title: "Contextual retry",
      objective: "Finish from prior evidence",
      acceptance: ["Release exists"],
      workflowPath,
      maxAttempts: 2,
    });

    const first = await runWorkItem({
      coordRoot: root,
      workId: "contextual-retry",
      engine: { spawners: {} },
    });
    expect(first.result).toEqual({ schema_version: 1, number: 1, trigger: "initial" });
    expect(readWorkItem(root, "contextual-retry").projection.state).toBe("blocked");

    const second = await runWorkItem({
      coordRoot: root,
      workId: "contextual-retry",
      retry: true,
      engine: { spawners: {} },
    });
    expect(second.result).toEqual({
      schema_version: 1,
      number: 2,
      trigger: "retry",
      prior: {
        run_id: first.runId,
        causes: ["acceptance_unknown"],
        acceptance: { satisfied: 0, unsatisfied: 0, unknown: 1, total: 1 },
        unresolved: [{ id: "release", statement: "Release exists", status: "unknown" }],
      },
    });
    const manifest = JSON.parse(
      readFileSync(join(root, ".harnery", "workflows", second.runId, "run.json"), "utf8"),
    );
    const proof = JSON.parse(readFileSync(second.proofPath, "utf8"));
    expect(manifest.attempt_context).toEqual(second.result);
    expect(proof.run.attempt_context).toEqual(second.result);
    expect(readWorkItem(root, "contextual-retry").projection.state).toBe("in_review");
  });

  test("a direct retry inherits the prior attempt's recorded specialist profiles", async () => {
    const requests: SpawnRequest[] = [];
    const releaseWarden: Spawner = async (request) => {
      requests.push(request);
      return { ok: true, text: "reviewed", durationMs: 1, costUsd: 0 };
    };
    const { root, workflowPath } = fixture(`
      export const meta = {
        name: "governed-retry",
        acceptance: [{ id: "retry-complete", statement: "The retry completed" }],
      };
      export default async (ctx) => {
        const response = await ctx.agent("Review the release", {
          specialist: "release-warden",
        });
        if (ctx.attempt.trigger === "retry") {
          ctx.evidence({
            kind: "artifact",
            status: "passed",
            label: "specialist retry completed",
            acceptanceIds: ["retry-complete"],
          });
        }
        return { response, trigger: ctx.attempt.trigger };
      };
    `);
    createWorkItem({
      coordRoot: root,
      id: "governed-retry",
      title: "Governed retry",
      objective: "Retry with the frozen release team",
      acceptance: ["The retry completed"],
      workflowPath,
      maxAttempts: 2,
    });

    const first = await runWorkItem({
      coordRoot: root,
      workId: "governed-retry",
      engine: {
        spawners: { codex: releaseWarden },
        specialists: {
          "release-warden": {
            instructions: "You are the frozen release reviewer.",
            adapter: "codex",
            effort: "high",
          },
        },
      },
    });
    expect(readWorkItem(root, "governed-retry").projection.state).toBe("blocked");

    const second = await runWorkItem({
      coordRoot: root,
      workId: "governed-retry",
      retry: true,
      engine: { spawners: { codex: releaseWarden } },
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]?.prompt).toStartWith("You are the frozen release reviewer.");
    expect(requests[1]?.effort).toBe("high");
    const firstManifest = JSON.parse(
      readFileSync(join(root, ".harnery", "workflows", first.runId, "run.json"), "utf8"),
    );
    const secondManifest = JSON.parse(
      readFileSync(join(root, ".harnery", "workflows", second.runId, "run.json"), "utf8"),
    );
    expect(secondManifest.execution.specialists).toEqual(firstManifest.execution.specialists);
    expect(readWorkItem(root, "governed-retry").projection.state).toBe("in_review");
  });

  test("a lost prior attempt is explicit without inventing a diagnosis", async () => {
    const { root, workflowPath } = fixture(`
      export default async ({ attempt }) => attempt;
    `);
    createWorkItem({
      coordRoot: root,
      id: "lost-retry",
      title: "Lost retry",
      objective: "Recover from missing terminal evidence",
      workflowPath,
      maxAttempts: 2,
    });
    appendFileSync(
      join(root, ".harnery", "work", "lost-retry", "events.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        work_id: "lost-retry",
        seq: 2,
        ts: new Date().toISOString(),
        event: "attempt.started",
        actor: "crashed-runner",
        reason: "workflow attempt started",
        run_id: "wf-lost",
        attempt: 1,
        trigger: "initial",
      })}\n`,
    );
    expect(readWorkItem(root, "lost-retry").projection.attempts[0]?.status).toBe("lost");

    const report = await runWorkItem({
      coordRoot: root,
      workId: "lost-retry",
      retry: true,
      engine: { spawners: {} },
    });
    expect(report.result).toEqual({
      schema_version: 1,
      number: 2,
      trigger: "retry",
      prior: { run_id: "wf-lost", causes: ["lost"], unresolved: [] },
    });
  });

  test("lists work when a legacy workflow transcript record exceeds the reader bound", () => {
    const { root, workflowPath } = fixture();
    createWorkItem({
      coordRoot: root,
      id: "unaffected",
      title: "Unaffected",
      objective: "Remain listable",
      workflowPath,
    });
    createWorkItem({
      coordRoot: root,
      id: "oversized-transcript",
      title: "Oversized transcript",
      objective: "Surface the unreadable attempt",
      workflowPath,
      maxAttempts: 2,
    });
    appendFileSync(
      join(root, ".harnery", "work", "oversized-transcript", "events.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        work_id: "oversized-transcript",
        seq: 2,
        ts: new Date().toISOString(),
        event: "attempt.started",
        actor: "legacy-runner",
        reason: "workflow attempt started",
        run_id: "wf-oversized-transcript",
        attempt: 1,
        trigger: "initial",
      })}\n`,
    );
    const runDir = join(root, ".harnery", "workflows", "wf-oversized-transcript");
    mkdirSync(runDir, { recursive: true });
    const oversizedLine = `${JSON.stringify({
      schema_version: 1,
      run_id: "wf-oversized-transcript",
      ts: new Date().toISOString(),
      event: "agent.end",
      stage: "",
      result: "x".repeat(WORKFLOW_TRANSCRIPT_EVENT_BYTES),
    })}\n`;
    expect(Buffer.byteLength(oversizedLine.trimEnd())).toBeGreaterThan(
      WORKFLOW_TRANSCRIPT_EVENT_BYTES,
    );
    writeFileSync(join(runDir, "transcript.jsonl"), oversizedLine, "utf8");

    const records = listWorkItems(root);
    expect(records.map((record) => record.intent.id).sort()).toEqual([
      "oversized-transcript",
      "unaffected",
    ]);
    const affected = records.find((record) => record.intent.id === "oversized-transcript");
    const unaffected = records.find((record) => record.intent.id === "unaffected");
    expect(unaffected?.projection.state).toBe("ready");
    expect(affected?.projection.state).toBe("blocked");
    expect(affected?.projection.next_action).toBe("retry");
    expect(affected?.projection.attempts.at(-1)?.status).toBe("transcript_unreadable");
    expect(affected?.projection.reason).toContain("transcript is unreadable");
    expect(affected?.projection.reason).toContain("oversized record");
  });

  test("governed reopen starts a fresh initial attempt instead of a retry", async () => {
    const { root, workflowPath } = fixture(`
      export default async ({ attempt }) => attempt;
    `);
    createWorkItem({
      coordRoot: root,
      id: "reopened-attempt",
      title: "Reopened attempt",
      objective: "Start again under fresh lifecycle authority",
      workflowPath,
      maxAttempts: 2,
    });
    const first = await runWorkItem({
      coordRoot: root,
      workId: "reopened-attempt",
      engine: { spawners: {} },
    });
    expect(first.result).toEqual({ schema_version: 1, number: 1, trigger: "initial" });
    reopenWorkItem(root, "reopened-attempt", { actor: "operator", reason: "run it again" });
    const second = await runWorkItem({
      coordRoot: root,
      workId: "reopened-attempt",
      engine: { spawners: {} },
    });
    expect(second.result).toEqual({ schema_version: 1, number: 2, trigger: "initial" });
  });

  test("an operator finding raised on reopen reaches the next attempt's agents", async () => {
    const { root, workflowPath } = fixture(`
      export default async ({ attempt }) => attempt;
    `);
    createWorkItem({
      coordRoot: root,
      id: "finding-reaches",
      title: "Finding reaches the team",
      objective: "Carry an operator correction into the next attempt",
      workflowPath,
      maxAttempts: 3,
    });
    const first = await runWorkItem({
      coordRoot: root,
      workId: "finding-reaches",
      engine: { spawners: {} },
    });
    expect((first.result as { findings?: unknown }).findings).toBeUndefined();

    reopenWorkItem(root, "finding-reaches", {
      actor: "operator",
      reason: "the reviewer missed a regression",
      findings: ["The bounded writer throws on a large result instead of truncating it."],
    });

    const second = await runWorkItem({
      coordRoot: root,
      workId: "finding-reaches",
      engine: { spawners: {} },
    });
    expect((second.result as { findings: unknown }).findings).toEqual([
      {
        id: "f1",
        actor: "operator",
        statement: "The bounded writer throws on a large result instead of truncating it.",
      },
    ]);
  });

  test("acceptance fails closed while an operator finding is undisposed", async () => {
    const { root, workflowPath } = fixture(`
      export default async () => 'ok';
    `);
    createWorkItem({
      coordRoot: root,
      id: "finding-gates",
      title: "Finding gates acceptance",
      objective: "Refuse acceptance while a correction is open",
      workflowPath,
      maxAttempts: 3,
    });
    await runWorkItem({ coordRoot: root, workId: "finding-gates", engine: { spawners: {} } });
    reopenWorkItem(root, "finding-gates", {
      actor: "operator",
      findings: ["Still wrong in the same way."],
    });
    await runWorkItem({ coordRoot: root, workId: "finding-gates", engine: { spawners: {} } });

    expect(() => acceptWorkItem(root, "finding-gates", { actor: "operator" })).toThrow(
      /operator findings are undisposed: f1/,
    );
    expect(() =>
      acceptWorkItem(root, "finding-gates", {
        actor: "operator",
        dispositions: [{ id: "f1", outcome: "deferred" }],
      }),
    ).toThrow(/requires a reason/);

    const accepted = acceptWorkItem(root, "finding-gates", {
      actor: "operator",
      dispositions: [{ id: "f1", outcome: "fixed" }],
    });
    expect(accepted.projection.state).toBe("succeeded");
    expect(openOperatorFindings(root, "finding-gates").findings).toEqual([]);
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

  test("fails closed when manifest attempt context disagrees with the work ledger", async () => {
    const { root, workflowPath } = fixture(`
      export default async ({ attempt }) => attempt;
    `);
    createWorkItem({
      coordRoot: root,
      id: "attempt-tamper",
      title: "Attempt tamper",
      objective: "Bind the attempt to the ledger",
      workflowPath,
    });
    const report = await runWorkItem({
      coordRoot: root,
      workId: "attempt-tamper",
      engine: { spawners: {} },
    });
    const manifestPath = join(root, ".harnery", "workflows", report.runId, "run.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.attempt_context.number = 2;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    expect(() => readWorkItem(root, "attempt-tamper")).toThrow(
      /attempt context does not match work item/,
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
    const manifest = JSON.parse(
      readFileSync(join(root, ".harnery", "workflows", report.runId, "run.json"), "utf8"),
    );
    expect(manifest.attempt_context).toEqual({
      schema_version: 1,
      number: 1,
      trigger: "initial",
    });
  });

  test("cancelling a parked attempt records authority without consuming another attempt", async () => {
    const host = mkdtempSync(join("/tmp", "harnery-work-cancel-"));
    roots.push(host);
    const workflowPath = join(host, "workflow.mjs");
    writeFileSync(
      workflowPath,
      `
        export default async ({ agent }) => agent("needs approval");
      `,
    );
    createWorkItem({
      coordRoot: host,
      id: "cancel-parked",
      title: "Cancel parked",
      objective: "Park then cancel",
      workflowPath,
    });

    await expect(
      runWorkItem({
        coordRoot: host,
        workId: "cancel-parked",
        engine: {
          spawners: {
            "claude-code": async () => ({ ok: true, text: "unused", durationMs: 1 }),
          },
          policy: { network: "ask" },
          networkAccess: "enabled",
          approvalMode: "park",
          cwd: host,
        },
      }),
    ).rejects.toThrow(WorkflowParkedError);

    const parked = readWorkItem(host, "cancel-parked");
    expect(parked.projection.state).toBe("awaiting_approval");
    const cancelled = cancelWorkItem(host, "cancel-parked", {
      actor: "operator",
      reason: "no longer needed",
    });
    expect(cancelled.projection.state).toBe("cancelled");
    expect(cancelled.projection.attempts_used).toBe(1);
    expect(cancelled.events.find((event) => event.event === "work.cancelled")).toMatchObject({
      event: "work.cancelled",
      actor: "operator",
      reason: "no longer needed",
    });
  });

  // ADR 0046: an attempt is charged only when it produced information about the
  // work. environment and upstream failures did not, and they need OPPOSITE
  // handling — so these run through the real engine with a classed spawner,
  // never a mock, to prove the class survives the whole per-agent → per-run →
  // proof → projection thread.
  const agentWorkflow = `export default async ({ agent }) => agent("do the work");\n`;
  function classedSpawner(cls: "environment" | "upstream", error: string): Spawner {
    return async () => ({ ok: false, text: "", durationMs: 1, error, class: cls });
  }

  test("an environment failure stops immediately and spends no attempt (ADR 0046)", async () => {
    const { root, workflowPath } = fixture(agentWorkflow);
    createWorkItem({
      coordRoot: root,
      id: "env-stop",
      title: "Env stop",
      objective: "Run against a missing binary",
      workflowPath,
      maxAttempts: 3,
    });
    await expect(
      runWorkItem({
        coordRoot: root,
        workId: "env-stop",
        engine: {
          spawners: { "claude-code": classedSpawner("environment", "codex not found on PATH") },
        },
      }),
    ).rejects.toThrow();

    const record = readWorkItem(root, "env-stop");
    // Blocked and STOPPED — the operator's chosen hard stop, not a retry.
    expect(record.projection.state).toBe("blocked");
    expect(record.projection.next_action).toBe("none");
    expect(record.projection.reason).toMatch(/precondition is missing/);
    // The attempt was recorded (ordering) but not charged; budget is intact.
    expect(record.projection.attempts_used).toBe(1);
    expect(record.projection.charged_attempts).toBe(0);
    expect(record.projection.attempts_remaining).toBe(3);
    expect(record.projection.attempts[0]?.uncharged).toBe("environment");
  });

  // A script that stops on a human is the third uncharged class. It has to be
  // told apart from a work failure, because to an engine that only sees "the run
  // threw" the two are identical — and conflating them means a correct refusal
  // gets re-issued until the attempt budget runs out.
  const blockingWorkflow =
    `export default async ({ blocked }) => blocked({\n` +
    `  reason: "who owns the cart is unsettled",\n` +
    `  decision: "fb-011-who-owns-the-cart-2026-08-01-beaf",\n` +
    `});\n`;

  test("a script that blocks on a human stops, uncharged, naming the decision", async () => {
    const { root, workflowPath } = fixture(blockingWorkflow);
    createWorkItem({
      coordRoot: root,
      id: "decision-stop",
      title: "Decision stop",
      objective: "Work that cannot proceed without a ruling",
      workflowPath,
      maxAttempts: 3,
    });
    await expect(
      runWorkItem({ coordRoot: root, workId: "decision-stop", engine: { spawners: {} } }),
    ).rejects.toThrow(/blocked on decision/);

    const record = readWorkItem(root, "decision-stop");
    // Terminal: a retry cannot change a person's mind, so next_action is none.
    expect(record.projection.state).toBe("blocked");
    expect(record.projection.next_action).toBe("none");
    // The operator gets the script's own sentence and a docket id to act on,
    // not the engine's wrapper prose repeated twice.
    expect(record.projection.reason).toBe(
      "a human must rule before this can proceed: who owns the cart is unsettled " +
        "(decision fb-011-who-owns-the-cart-2026-08-01-beaf)",
    );
    // Uncharged: once the decision lands, the item retries with a full budget.
    expect(record.projection.attempts_used).toBe(1);
    expect(record.projection.charged_attempts).toBe(0);
    expect(record.projection.attempts_remaining).toBe(3);
    expect(record.projection.attempts[0]?.uncharged).toBe("decision");
    expect(record.projection.attempts[0]?.blocked_on).toBe(
      "fb-011-who-owns-the-cart-2026-08-01-beaf",
    );
    // Machine-readable, so a reader never has to parse the reason prose.
    expect(record.projection.blocked_on_decision).toBe("fb-011-who-owns-the-cart-2026-08-01-beaf");
  });

  test("blocking without naming a decision still stops rather than retrying", async () => {
    const { root, workflowPath } = fixture(
      `export default async ({ blocked }) => blocked({ reason: "needs a product call" });\n`,
    );
    createWorkItem({
      coordRoot: root,
      id: "decision-unnamed",
      title: "Decision unnamed",
      objective: "Blocked with no docket id",
      workflowPath,
      maxAttempts: 3,
    });
    await expect(
      runWorkItem({ coordRoot: root, workId: "decision-unnamed", engine: { spawners: {} } }),
    ).rejects.toThrow();

    const record = readWorkItem(root, "decision-unnamed");
    expect(record.projection.state).toBe("blocked");
    expect(record.projection.next_action).toBe("none");
    expect(record.projection.charged_attempts).toBe(0);
    // Present but empty: still positively "waiting on a person", just without a
    // question to point at — which is the degraded case, not a different one.
    expect(record.projection.blocked_on_decision).toBe("");
    expect(record.projection.reason).toBe(
      "a human must rule before this can proceed: needs a product call",
    );
  });

  test("an upstream failure is uncharged but stays retryable (ADR 0046)", async () => {
    const { root, workflowPath } = fixture(agentWorkflow);
    createWorkItem({
      coordRoot: root,
      id: "upstream-retry",
      title: "Upstream retry",
      objective: "Vendor refused",
      workflowPath,
      maxAttempts: 3,
    });
    await expect(
      runWorkItem({
        coordRoot: root,
        workId: "upstream-retry",
        engine: {
          spawners: {
            "claude-code": classedSpawner("upstream", "503 service unavailable: circuit_open"),
          },
        },
      }),
    ).rejects.toThrow();

    const record = readWorkItem(root, "upstream-retry");
    expect(record.projection.state).toBe("blocked");
    // Retry stays available — the vendor may recover — and no budget was spent.
    expect(record.projection.next_action).toBe("retry");
    expect(record.projection.reason).toMatch(/outside service refused/);
    expect(record.projection.charged_attempts).toBe(0);
    expect(record.projection.attempts_remaining).toBe(3);
    expect(record.projection.attempts[0]?.uncharged).toBe("upstream");
  });

  test("consecutive upstream failures are bounded and name the outside service (ADR 0046)", async () => {
    const { root, workflowPath } = fixture(agentWorkflow);
    createWorkItem({
      coordRoot: root,
      id: "upstream-bound",
      title: "Upstream bound",
      objective: "Outage that never ends",
      workflowPath,
      maxAttempts: 5,
      // Bound consecutive uncharged attempts below the work budget so it is the
      // brake that fires, not budget exhaustion.
      maxUnchargedAttempts: 2,
    });
    const engine = {
      spawners: {
        "claude-code": classedSpawner("upstream", "503 service unavailable: circuit_open"),
      },
    };

    // First upstream failure: uncharged, still retryable.
    await expect(
      runWorkItem({ coordRoot: root, workId: "upstream-bound", engine }),
    ).rejects.toThrow();
    expect(readWorkItem(root, "upstream-bound").projection.next_action).toBe("retry");

    // Second consecutive uncharged failure hits the bound.
    await expect(
      runWorkItem({ coordRoot: root, workId: "upstream-bound", retry: true, engine }),
    ).rejects.toThrow();

    const bounded = readWorkItem(root, "upstream-bound");
    expect(bounded.projection.state).toBe("blocked");
    expect(bounded.projection.next_action).toBe("none");
    expect(bounded.projection.reason).toMatch(/outside service/);
    // Budget was never spent even though the item stopped: it is blocked on the
    // vendor, not on the work.
    expect(bounded.projection.charged_attempts).toBe(0);
    expect(bounded.projection.attempts_remaining).toBe(5);
    expect(bounded.projection.attempts_used).toBe(2);
  });

  test("an unclassed spawn failure charges the attempt exactly as before (ADR 0046 default)", async () => {
    const { root, workflowPath } = fixture(agentWorkflow);
    createWorkItem({
      coordRoot: root,
      id: "charged-default",
      title: "Charged default",
      objective: "Ordinary work failure",
      workflowPath,
      maxAttempts: 3,
    });
    await expect(
      runWorkItem({
        coordRoot: root,
        workId: "charged-default",
        // No class on the spawn result: an ordinary work failure.
        engine: {
          spawners: {
            "claude-code": async () => ({
              ok: false,
              text: "",
              durationMs: 1,
              error: "the model produced nothing usable",
            }),
          },
        },
      }),
    ).rejects.toThrow();

    const record = readWorkItem(root, "charged-default");
    expect(record.projection.state).toBe("blocked");
    // Charged and retryable — the status quo for anything not positively classed.
    expect(record.projection.next_action).toBe("retry");
    expect(record.projection.charged_attempts).toBe(1);
    expect(record.projection.attempts_remaining).toBe(2);
    expect(record.projection.attempts[0]?.uncharged).toBeUndefined();
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
    expect(() => readWorkItem(root, "truncated")).toThrow(
      "durable history has a partial record: events.jsonl",
    );
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
