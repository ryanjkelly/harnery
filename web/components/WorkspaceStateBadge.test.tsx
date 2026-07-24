import { describe, expect, test } from "bun:test";
import type { WorkflowWorkspaceInspection, WorkflowWorkspaceStatus } from "harnery/core/workflow";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceStateBadge } from "./WorkspaceStateBadge";

describe("WorkspaceStateBadge", () => {
  test("labels isolated lifecycle and invalid authority distinctly", () => {
    const isolated: WorkflowWorkspaceInspection = {
      ok: true,
      value: sampleStatus(),
    };
    expect(renderToStaticMarkup(<WorkspaceStateBadge inspection={isolated} />)).toContain(
      "completed unintegrated",
    );

    const invalid: WorkflowWorkspaceInspection = {
      ok: false,
      run_id: "wf-bad",
      error: "provider event chain is corrupt",
    };
    const invalidMarkup = renderToStaticMarkup(<WorkspaceStateBadge inspection={invalid} />);
    expect(invalidMarkup).toContain("workspace invalid");
    expect(invalidMarkup).toContain("border-destructive");
  });

  test("shows compatibility fallback without calling it isolated", () => {
    const compatibility = sampleStatus();
    compatibility.selection = "compatibility";
    compatibility.requested_isolation = "worktree";
    compatibility.effective_isolation = "shared";
    compatibility.compatibility = {
      reason: "provider_not_configured",
      unsupported: [],
      unknowns: [],
    };
    expect(
      renderToStaticMarkup(<WorkspaceStateBadge inspection={{ ok: true, value: compatibility }} />),
    ).toContain("worktree → shared");
  });
});

function sampleStatus(): WorkflowWorkspaceStatus {
  return {
    schema_version: 1,
    run_id: "wf-test",
    run_name: "test",
    started_at: "2026-07-24T00:00:00.000Z",
    selection: "isolated",
    requested_isolation: "worktree",
    effective_isolation: "worktree",
    provider: {
      id: "local-git-worktree",
      version: "1",
      capability_digest: "a".repeat(64),
    },
    lifecycle: {
      state: "completed_unintegrated",
      workflow_outcome: "completed_unintegrated",
      resource_state: "active",
      integration_state: "none",
      provider_event_chain_sha256: "b".repeat(64),
      cancellation: "none",
    },
    verification: {
      status: "ok",
      workflow_status: "succeeded",
      drift: [],
      unsupported: [],
      unknowns: [],
    },
    integration: { state: "none", changed_paths: [] },
    cleanup: { state: "not_requested", attempts: 0 },
    repository: { dirty_paths: [], conflicts: [], operations_in_progress: [] },
    integrity: {
      status: "verified",
      proof_sha256: "c".repeat(64),
      provider_event_chain_sha256: "b".repeat(64),
    },
  };
}
