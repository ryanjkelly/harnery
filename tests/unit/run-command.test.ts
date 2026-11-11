import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerWorkflowCommand } from "../../src/commands/run.ts";
import { writeWorkflowProof } from "../../src/core/run/proof.ts";
import { writeWorkflowRunManifest } from "../../src/core/run/run-state.ts";
import type { WorkflowProof } from "../../src/core/run/types.ts";
import { removeDir } from "../helpers/remove-dir.ts";

// Windows has no /tmp; elsewhere keep the short /tmp root.
const TEMP_ROOT = process.platform === "win32" ? tmpdir() : "/tmp";

let root: string;
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  root = join(TEMP_ROOT, `workflow-command-test-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, ".harnery", "workflows", "wf-command"), { recursive: true });
  writeWorkflowRunManifest({
    coordRoot: root,
    manifest: {
      schema_version: 2,
      run_id: "wf-command",
      name: "command",
      started_at: "2026-07-21T12:00:00.000Z",
      script: { path: join(root, "workflow.mjs"), sha256: "b".repeat(64) },
      repository_before: {
        cwd: root,
        root,
        observation: "ok",
        branch: "main",
        head: "a".repeat(40),
        dirty_paths: [],
      },
      execution: {
        cwd: root,
        default_adapter: "claude-code",
        max_agents: 1,
        concurrency: 1,
        subscription_only: false,
        allow_api_billing: false,
        approval_mode: "deny",
        approval_addressee: "operator",
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
  removeDir(root);
});

describe("workflow proof command", () => {
  test("human and JSON proof output preserve unknown repository drift", async () => {
    const proof = sampleProof();
    proof.repository.before.dirty_paths = ["checkpoint.txt"];
    proof.repository.after.observation = "unavailable";
    proof.repository.after.observation_detail = "not_repository";
    // An existing packet may contain a comparison made before observation checks.
    proof.repository.drift.dirty_paths_cleared = ["checkpoint.txt"];
    writeFileSync(
      join(root, ".harnery", "workflows", "wf-command", "proof.json"),
      `${JSON.stringify(proof)}\n`,
    );
    const output: string[] = [];
    let captured: unknown;
    const emit = {
      text: (value: string) => output.push(value),
      data: (value: unknown) => {
        captured = value;
      },
      config: () => {},
      error: (error: { message: string }) => {
        throw new Error(error.message);
      },
    };
    await runCommand(["run", "proof", "wf-command"], emit);
    expect(output.join("\n")).toContain("repository: drift unknown");
    expect(output.join("\n")).toContain("not_repository");
    expect(output.join("\n")).not.toContain("1 cleared");
    await runCommand(["run", "proof", "wf-command", "--json"], emit);
    expect((captured as WorkflowProof).repository.drift).toMatchObject({
      branch_changed: null,
      head_changed: null,
      dirty_paths_added: null,
      dirty_paths_cleared: null,
      dirty_paths_retained: null,
      incomplete: true,
    });
  });

  test("offers no workspace, integration or admission commands and flags", () => {
    const program = new Command();
    registerWorkflowCommand(program, {} as never);
    const run = program.commands.find((command) => command.name() === "run");
    expect(run?.commands.map((command) => command.name()).sort()).toEqual([
      "proof",
      "resume",
      "script",
    ]);
    const script = run?.commands.find((command) => command.name() === "script");
    const flags = script?.options.map((option) => option.long) ?? [];
    expect(flags).toContain("--policy");
    expect(flags).toContain("--approval-to");
    for (const removed of ["--isolation", "--workspace-root", "--observe-pressure"]) {
      expect(flags).not.toContain(removed);
    }
  });

  test("renders the human proof summary", async () => {
    const output: string[] = [];
    await runCommand(["run", "proof", "wf-command"], {
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
    await runCommand(["run", "proof", "wf-command", "--json"], {
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
    schema_version: 2,
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
      before: {
        cwd: root,
        root,
        observation: "ok",
        branch: "main",
        head: "a".repeat(40),
        dirty_paths: [],
      },
      after: {
        cwd: root,
        root,
        observation: "ok",
        branch: "main",
        head: "a".repeat(40),
        dirty_paths: [],
      },
      drift: {
        branch_changed: false,
        head_changed: false,
        dirty_paths_added: [],
        dirty_paths_cleared: [],
        dirty_paths_retained: [],
        incomplete: false,
      },
    },
    adapters: [],
    unknowns: [],
    integrity: { transcript: { path: "transcript.jsonl", sha256: "a".repeat(64), bytes: 10 } },
  };
}
