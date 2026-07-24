import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createLocalGitWorktreeProvider,
  prepareIntegration,
  probeLocalGitWorktreeProvider,
  WORKSPACE_BINDING_SCHEMA_VERSION,
  WORKSPACE_RECEIPT_SCHEMA_VERSION,
} from "../../src/core/workflow/index.ts";
import type {
  RepositoryBinding,
  ValidatedFilesystemPath,
  WorkspaceObservation,
  WorkspaceProofOutcome,
  WorkspaceResourceState,
} from "../../src/core/workflow/index.ts";

type ApprovedWorkspaceTypes = {
  path: ValidatedFilesystemPath;
  repository: RepositoryBinding;
  observation: WorkspaceObservation;
  outcome: WorkspaceProofOutcome;
  resource: WorkspaceResourceState;
};

describe("workspace product-tier surface", () => {
  test("uses the existing core/workflow export without adding a provider subpath", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(packageJson.exports["./core/workflow"]).toBeDefined();
    expect(packageJson.exports["./core/workspaces"]).toBeUndefined();
    expect(packageJson.exports["./core/workspace-provider"]).toBeUndefined();
    expect(WORKSPACE_BINDING_SCHEMA_VERSION).toBe(1);
    expect(WORKSPACE_RECEIPT_SCHEMA_VERSION).toBe(1);
    expect(typeof createLocalGitWorktreeProvider).toBe("function");
    expect(typeof probeLocalGitWorktreeProvider).toBe("function");
    expect(typeof prepareIntegration).toBe("function");
    expect(undefined as ApprovedWorkspaceTypes | undefined).toBeUndefined();
  });
});
