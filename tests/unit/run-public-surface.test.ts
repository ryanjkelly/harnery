import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as run from "../../src/core/run/index.ts";

describe("run product-tier surface", () => {
  test("exports the run engine from core/run and nothing for removed features", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(packageJson.exports["./core/run"]).toBeDefined();
    expect(packageJson.exports["./core/policy"]).toBeDefined();
    expect(packageJson.exports["./core/workflow"]).toBeUndefined();
    expect(packageJson.exports["./core/workspaces"]).toBeUndefined();
    expect(typeof run.runWorkflow).toBe("function");
    expect(typeof run.readWorkflowProof).toBe("function");
    expect(typeof run.createWorkflowApproval).toBe("function");
    expect(typeof run.validateAgainstSchema).toBe("function");
    // Isolated workspaces, integration and observer admission were removed
    // (ADR 0244); none of their exports may come back by accident.
    for (const removed of [
      "createLocalGitWorktreeProvider",
      "probeLocalGitWorktreeProvider",
      "prepareIntegration",
      "applyIntegration",
      "cleanupWorkspace",
      "inspectWorkflowWorkspace",
      "listWorkflowWorkspaceInspections",
      "readWorkflowWorkspaceStatus",
      "WORKSPACE_BINDING_SCHEMA_VERSION",
      "observeWorkflowDiagnosticAdmission",
      "WORKFLOW_DIAGNOSTIC_ADMISSION_SCHEMA_VERSION",
    ]) {
      expect(run).not.toHaveProperty(removed);
    }
  });
});
