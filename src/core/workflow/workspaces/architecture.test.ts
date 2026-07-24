import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("workspace provider authority boundaries", () => {
  test("provider modules cannot write host work, proof, supervisor, retry, or budget state", () => {
    for (const file of ["local-git.ts", "git.ts", "paths.ts", "leases.ts"]) {
      const provider = readFileSync(join(root, "src/core/workflow/workspaces", file), "utf8");
      expect(provider).not.toContain("../../work/");
      expect(provider).not.toContain("../../supervisor/");
      expect(provider).not.toContain("writeWorkflowProof");
      expect(provider).not.toContain("writeWorkflowSupplement");
      expect(provider).not.toContain("attempt.started");
      expect(provider).not.toContain("max_attempts");
      expect(provider).not.toContain("cumulative_cost");
      expect(provider).not.toContain(".harnery/work/");
      expect(provider).not.toContain("integration/receipt.json");
      expect(provider).not.toContain("cleanup/receipt.json");
    }
  });

  test("generic durable records are neutral and remain outside the product export", () => {
    for (const file of [
      "src/core/work/state.ts",
      "src/core/workflow/proof.ts",
      "src/core/workflow/run-state.ts",
    ]) {
      expect(readFileSync(join(root, file), "utf8")).not.toContain("workspaces/state.ts");
    }
    const workflowIndex = readFileSync(join(root, "src/core/workflow/index.ts"), "utf8");
    expect(workflowIndex).not.toContain("durable-record");
  });

  test("provider integration accepts frozen facts and digests, never a workflow proof object", () => {
    const types = readFileSync(join(root, "src/core/workflow/workspaces/types.ts"), "utf8");
    const providerInterface = types.slice(types.indexOf("export interface WorkspaceProvider"));
    expect(providerInterface).toContain("previewIntegration(input: ProviderIntegrationInput)");
    expect(providerInterface).toContain("applyAuthorizedIntegration");
    expect(providerInterface).not.toContain("WorkflowProof");
  });

  test("execution binding orchestration is outside the workflow engine", () => {
    const engine = readFileSync(join(root, "src/core/workflow/engine.ts"), "utf8");
    const execution = readFileSync(join(root, "src/core/workflow/workspaces/execution.ts"), "utf8");
    expect(engine).not.toContain("async function resolveWorkspaceBinding");
    expect(execution).toContain("export async function resolveWorkspaceBinding");
  });

  test("cleanup serialization is durable and has no process-local queue", () => {
    const cleanup = readFileSync(join(root, "src/core/workflow/workspaces/cleanup.ts"), "utf8");
    expect(cleanup).not.toContain("cleanupQueues");
    expect(cleanup).not.toContain("new Map");
    expect(cleanup).toContain("acquireNoClobberLease");
  });
});
