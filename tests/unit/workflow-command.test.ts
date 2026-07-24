import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { registerWorkflowCommand } from "../../src/commands/workflow.ts";
import { writeWorkflowProof } from "../../src/core/workflow/proof.ts";
import { writeWorkflowRunManifest } from "../../src/core/workflow/run-state.ts";
import type { WorkflowProof } from "../../src/core/workflow/types.ts";

let root: string;
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  root = join("/tmp", `workflow-command-test-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, ".harnery", "workflows", "wf-command"), { recursive: true });
  writeWorkflowRunManifest({
    coordRoot: root,
    manifest: {
      schema_version: 1,
      run_id: "wf-command",
      name: "command",
      started_at: "2026-07-21T12:00:00.000Z",
      script: { path: join(root, "workflow.mjs"), sha256: "b".repeat(64) },
      repository_before: { cwd: root, dirty_paths: [] },
      execution: {
        cwd: root,
        default_harness: "claude-code",
        max_agents: 1,
        concurrency: 1,
        subscription_only: false,
        allow_api_billing: false,
        approval_mode: "deny",
        approval_addressee: "operator",
        isolation: "shared",
        network_access: "unknown",
      },
    },
  });
  writeWorkflowProof(
    join(root, ".harnery", "workflows", "wf-command", "proof.json"),
    sampleProof(),
  );
  process.chdir(root);
});

afterEach(() => {
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("workflow proof command", () => {
  test("renders the human proof summary", async () => {
    const output: string[] = [];
    await runCommand(["workflow", "proof", "wf-command"], {
      text: (value) => output.push(value),
      data: () => {},
      config: () => {},
      error: (error) => {
        throw new Error(error.message);
      },
    });
    expect(output.join("\n")).toContain("run wf-command (command): succeeded");
    expect(output.join("\n")).toContain("acceptance: 1 satisfied");
  });

  test("emits the stored packet unchanged in JSON mode", async () => {
    let captured: unknown;
    await runCommand(["workflow", "proof", "wf-command", "--json"], {
      text: () => {},
      data: (value) => {
        captured = value;
      },
      config: () => {},
      error: (error) => {
        throw new Error(error.message);
      },
    });
    expect((captured as WorkflowProof).run.id).toBe("wf-command");
  });
});

async function runCommand(
  args: string[],
  emit: {
    text: (value: string) => void;
    data: (value: unknown) => void;
    config: (value: unknown) => void;
    error: (value: { message: string }) => void;
  },
): Promise<void> {
  const program = new Command();
  registerWorkflowCommand(program, emit as never);
  await program.parseAsync(args, { from: "user" });
}

function sampleProof(): WorkflowProof {
  return {
    schema_version: 1,
    run: {
      id: "wf-command",
      name: "command",
      status: "succeeded",
      started_at: "2026-07-21T12:00:00.000Z",
      ended_at: "2026-07-21T12:00:01.000Z",
      duration_ms: 1_000,
    },
    acceptance: {
      criteria: [
        {
          id: "proof",
          statement: "Proof renders",
          status: "satisfied",
          evidence_ids: ["e1"],
          sources: ["workflow"],
        },
      ],
      summary: { satisfied: 1, unsatisfied: 0, unknown: 0, total: 1 },
    },
    agents: [],
    evidence: [],
    repository: {
      source: "engine",
      before: { cwd: root, dirty_paths: [] },
      after: { cwd: root, dirty_paths: [] },
      drift: {
        branch_changed: false,
        head_changed: false,
        dirty_paths_added: [],
        dirty_paths_cleared: [],
        dirty_paths_retained: [],
        incomplete: false,
      },
    },
    harnesses: [],
    unknowns: [],
    integrity: { journal: { path: "journal.jsonl", sha256: "a".repeat(64), bytes: 10 } },
  };
}
