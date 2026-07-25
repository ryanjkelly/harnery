import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext } from "../commander.ts";
import { createWorkItem, type WorkAttempt } from "../core/work/index.ts";
import { renderAttemptRow } from "./work.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("work command", () => {
  test("registers the complete durable-work surface", () => {
    const program = createHarneryProgram();
    const command = program.commands.find((candidate) => candidate.name() === "work");
    expect(command).toBeDefined();
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "create",
      "list",
      "show",
      "reconcile",
      "run",
      "retry",
      "accept",
      "cancel",
      "reopen",
    ]);
  });

  test("work show explains why an attempt journal is unreadable", async () => {
    const root = mkdtempSync(join("/tmp", "harnery-work-command-"));
    roots.push(root);
    const workflowPath = join(root, "workflow.mjs");
    writeFileSync(workflowPath, "export default async () => 'ok';\n");
    createWorkItem({
      coordRoot: root,
      id: "journal-detail",
      title: "Journal detail",
      objective: "Surface unreadable journal details",
      workflowPath,
      maxAttempts: 2,
    });
    appendAttemptStarted(root, "journal-detail", 2, "wf-unreadable", 1);
    appendAttemptStarted(root, "journal-detail", 3, "wf-lost", 2);
    mkdirSync(join(root, ".harnery", "workflows", "wf-unreadable"), { recursive: true });
    writeFileSync(join(root, ".harnery", "workflows", "wf-unreadable", "journal.jsonl"), "[]\n");

    const output: string[] = [];
    const previousOverride = process.env.HARNERY_COORD_ROOT_OVERRIDE;
    process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
    try {
      await createHarneryProgram({ emit: captureText(output) }).parseAsync(
        ["work", "show", "journal-detail"],
        { from: "user" },
      );
    } finally {
      if (previousOverride === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
      else process.env.HARNERY_COORD_ROOT_OVERRIDE = previousOverride;
    }

    const text = output.join("");
    expect(text).toContain("reason: workflow attempt 2 ended without terminal evidence");
    expect(text).toContain(
      "  1. wf-unreadable  journal_unreadable: cannot parse workflow run wf-unreadable journal: expected object",
    );
    expect(text).toContain("  2. wf-lost  lost");
  });

  test("work show keeps multiline journal errors on one attempt row", () => {
    const attempts: WorkAttempt[] = [
      {
        number: 1,
        run_id: "wf-multiline",
        started_at: "2026-07-25T12:00:00.000Z",
        status: "journal_unreadable",
        journal_error: "first line\nsecond line\tthird  line",
      },
      {
        number: 2,
        run_id: "wf-next",
        started_at: "2026-07-25T12:01:00.000Z",
        status: "lost",
      },
    ];

    const block = ["attempts:", ...attempts.map(renderAttemptRow)].join("\n");

    expect(block.split("\n")).toEqual([
      "attempts:",
      "  1. wf-multiline  journal_unreadable: first line second line third line",
      "  2. wf-next  lost",
    ]);
  });

  test("work show truncates long journal errors in human attempt rows", () => {
    const row = renderAttemptRow({
      number: 1,
      run_id: "wf-long",
      started_at: "2026-07-25T12:00:00.000Z",
      status: "journal_unreadable",
      journal_error: `start ${"x".repeat(300)} end`,
    });

    expect(row.startsWith("  1. wf-long  journal_unreadable: start ")).toBe(true);
    expect(row.endsWith("...")).toBe(true);
    expect(row).not.toContain(" end");
    expect(row.length).toBeLessThanOrEqual("  1. wf-long  journal_unreadable: ".length + 240);
  });
});

function appendAttemptStarted(
  root: string,
  workId: string,
  seq: number,
  runId: string,
  attempt: number,
): void {
  appendFileSync(
    join(root, ".harnery", "work", workId, "events.jsonl"),
    `${JSON.stringify({
      schema_version: 1,
      work_id: workId,
      seq,
      ts: "2026-07-25T12:00:00.000Z",
      event: "attempt.started",
      actor: "test-runner",
      reason: "workflow attempt started",
      run_id: runId,
      attempt,
      trigger: attempt === 1 ? "initial" : "retry",
    })}\n`,
  );
}

function captureText(output: string[]): EmitContext {
  return {
    config: () => {},
    data: () => {},
    rows: () => {},
    text: (value) => output.push(value),
    file: () => {},
    error: (error) => {
      if (error instanceof Error) throw error;
      const message =
        typeof error === "object" &&
        error &&
        "message" in error &&
        typeof error.message === "string"
          ? error.message
          : "command error";
      throw new Error(message);
    },
    log: () => {},
    setExitCode: (code) => {
      throw new Error(`unexpected exit code ${code}`);
    },
  };
}
