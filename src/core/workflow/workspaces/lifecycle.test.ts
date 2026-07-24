import { describe, expect, test } from "bun:test";
import type { WorkflowRunManifest } from "../run-state.ts";
import type { WorkflowProof } from "../types.ts";
import {
  assertWorkspaceLifecycleTransition,
  deriveWorkspaceLifecycle,
  isWorkspaceLifecycleState,
  validateProviderEventChain,
} from "./lifecycle.ts";
import { stableDigest, type WorkspaceProviderEvent } from "./state.ts";
import type {
  FilesystemIdentity,
  WorkspaceAttestation,
  WorkspaceBinding,
  WorkspaceCleanupAttempt,
  WorkspaceCleanupReceipt,
} from "./types.ts";

const identity: FilesystemIdentity = {
  platform: process.platform,
  device: "1",
  inode: "1",
};

function binding(): WorkspaceBinding {
  return {
    schema_version: 1,
    binding_id: "binding",
    workspace_id: "workspace",
    run_id: "run",
    owner: { kind: "standalone", work_item_id: null, attempt: null },
    provider: { id: "provider", version: "1", capability_digest: "c".repeat(64) },
    isolation: "worktree",
    network_access: "unknown",
    workspace_root: "/tmp/root/workspace",
    workspace_root_identity: identity,
    active_root: "/tmp/root/workspace",
    active_root_identity: identity,
    writable_root: { configured: "/tmp/root", realpath: "/tmp/root", identity },
    generation: 1,
    recovery_token: "d".repeat(64),
    request_sha256: "a".repeat(64),
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function attestation(
  resourceState: "active" | "released",
  recordedAt = "2026-01-01T00:00:01.000Z",
): WorkspaceAttestation {
  const released = resourceState === "released";
  return {
    schema_version: 1,
    binding_id: "binding",
    workspace_id: "workspace",
    run_id: "run",
    owner: { kind: "standalone", work_item_id: null, attempt: null },
    provider: { id: "provider", version: "1", capability_digest: "c".repeat(64) },
    recorded_at: recordedAt,
    containment: {
      writable_root: true,
      workspace_root: !released,
      active_root: !released,
      integration_root: null,
    },
    filesystem: {
      root_identity_match: true,
      workspace_identity: released ? undefined : identity,
      active_identity: released ? undefined : identity,
    },
    provider_drift: [],
    workspace_exists: !released,
    resource_state: resourceState,
    unsupported: [],
    unknowns: [],
    status: "ok",
  };
}

function proof(workspaceBinding: WorkspaceBinding): WorkflowProof {
  const terminal = attestation("active");
  return {
    run: { status: "succeeded" },
    execution: {
      schema_version: 1,
      binding: workspaceBinding,
      terminal_attestation: terminal,
      terminal_lifecycle_state: "completed_unintegrated",
      drift: [],
      unsupported: [],
      unknowns: [],
      receipts: { request: "workspace-request.json" },
    },
  } as unknown as WorkflowProof;
}

function cleanupAttempt(
  workspaceBinding: WorkspaceBinding,
  terminal: WorkspaceAttestation,
): WorkspaceCleanupAttempt {
  const basis = {
    schema_version: 1 as const,
    seq: 1,
    previous_sha256: null,
    operation_id: `cleanup-${stableDigest({
      binding: stableDigest(workspaceBinding),
      mode: "normal",
    }).slice(0, 24)}`,
    binding_id: workspaceBinding.binding_id,
    binding_sha256: stableDigest(workspaceBinding),
    mode: "normal" as const,
    status: "released" as const,
    branch_deleted: true,
    attestation: terminal,
    recorded_at: terminal.recorded_at,
  };
  return { ...basis, record_sha256: stableDigest(basis) };
}

function cleanupReceipt(
  workspaceBinding: WorkspaceBinding,
  terminal: WorkspaceAttestation,
): WorkspaceCleanupReceipt {
  const operationId = `cleanup-${stableDigest({
    binding: stableDigest(workspaceBinding),
    mode: "normal",
  }).slice(0, 24)}`;
  return {
    schema_version: 1,
    receipt_id: "cleanup-receipt",
    operation_id: operationId,
    binding_id: workspaceBinding.binding_id,
    binding_sha256: stableDigest(workspaceBinding),
    mode: "normal",
    status: "released",
    branch_deleted: true,
    attestation: terminal,
    recorded_at: terminal.recorded_at,
  };
}

function event(
  seq: number,
  name: string,
  prior: WorkspaceProviderEvent | undefined,
  data: Record<string, unknown> = {},
): WorkspaceProviderEvent {
  const basis = {
    schema_version: 1 as const,
    seq,
    previous_sha256: prior?.record_sha256 ?? null,
    event: name,
    recorded_at: "2026-01-01T00:00:00.000Z",
    request_sha256: "a".repeat(64),
    binding_id: "binding",
    workspace_id: "workspace",
    data,
  };
  return { ...basis, record_sha256: stableDigest(basis) };
}

describe("workspace lifecycle projection", () => {
  test("validates the executable state union and legal transitions", () => {
    expect(isWorkspaceLifecycleState("integrating")).toBe(true);
    expect(isWorkspaceLifecycleState("cancelled")).toBe(false);
    expect(() => assertWorkspaceLifecycleTransition("allocating", "bound")).not.toThrow();
    expect(() => assertWorkspaceLifecycleTransition("released", "running")).toThrow(/illegal/);
  });

  test("derives lifecycle from provider and host-owned durable evidence", () => {
    const workspaceBinding = binding();
    const releasedAttestation = attestation("released", "2026-01-01T00:00:05.000Z");
    const allocated = event(1, "allocation_recorded", undefined);
    const allocating = event(2, "allocating", allocated);
    const bound = event(3, "bound", allocating);
    const cleanupPending = event(4, "cleanup_pending", bound);
    const released = event(5, "released", cleanupPending, {
      branch_deleted: true,
      attestation_sha256: stableDigest(releasedAttestation),
    });
    const projection = deriveWorkspaceLifecycle({
      binding: workspaceBinding,
      provider_events: [allocated, allocating, bound, cleanupPending, released],
      workflow_journal: [{ event: "run.start" }, { event: "run.end", ok: true }],
      proof: proof(workspaceBinding),
      cleanup_attempts: [cleanupAttempt(workspaceBinding, releasedAttestation)],
      cleanup_receipt: cleanupReceipt(workspaceBinding, releasedAttestation),
    });
    expect(projection.state).toBe("released");
    expect(projection.workflow_outcome).toBe("completed_unintegrated");
    expect(projection.resource_state).toBe("released");
    expect(projection.integration_state).toBe("none");
    expect(projection.provider_event_chain_sha256).toBe(released.record_sha256);
    expect(
      deriveWorkspaceLifecycle({
        binding: workspaceBinding,
        provider_events: [allocated, allocating, bound, cleanupPending, released],
        workflow_journal: [{ event: "run.start" }, { event: "run.end", ok: true }],
      }).state,
    ).toBe("cleanup_pending");
  });

  test("fails closed after run.end until durable proof exists", () => {
    const workspaceBinding = binding();
    const allocated = event(1, "allocation_recorded", undefined);
    const allocating = event(2, "allocating", allocated);
    const bound = event(3, "bound", allocating);

    expect(
      deriveWorkspaceLifecycle({
        binding: workspaceBinding,
        provider_events: [allocated, allocating, bound],
        workflow_journal: [{ event: "run.start" }, { event: "run.end", ok: false }],
      }),
    ).toMatchObject({
      state: "blocked",
      workflow_outcome: "failed_retained",
    });
    expect(
      deriveWorkspaceLifecycle({
        binding: workspaceBinding,
        provider_events: [allocated, allocating, bound],
        workflow_journal: [{ event: "run.start" }, { event: "run.end", ok: true }],
      }),
    ).toMatchObject({
      state: "blocked",
      workflow_outcome: null,
    });
  });

  test("rejects integration state projected from artifact presence alone", () => {
    const workspaceBinding = binding();
    expect(() =>
      deriveWorkspaceLifecycle({
        binding: workspaceBinding,
        proof: proof(workspaceBinding),
        proof_sha256: "f".repeat(64),
        integration_plan: {} as never,
        integration_attempts: [{ status: "started" } as never],
        integration_receipt: {} as never,
      }),
    ).toThrow(/integration plan is corrupt or foreign/);
  });

  test("projects a resumed parked run as running", () => {
    const workspaceBinding = binding();
    const allocated = event(1, "allocation_recorded", undefined);
    const allocating = event(2, "allocating", allocated);
    const bound = event(3, "bound", allocating);

    expect(
      deriveWorkspaceLifecycle({
        binding: workspaceBinding,
        provider_events: [allocated, allocating, bound],
        workflow_journal: [
          { event: "run.start" },
          { event: "run.parked" },
          { event: "run.resume" },
        ],
      }).state,
    ).toBe("running");
  });

  test("a validated cleanup receipt supersedes an older active proof attestation", () => {
    const workspaceBinding = binding();
    const releasedAttestation = attestation("released", "2026-01-01T00:00:05.000Z");
    const allocated = event(1, "allocation_recorded", undefined);
    const allocating = event(2, "allocating", allocated);
    const bound = event(3, "bound", allocating);
    const cleanupPending = event(4, "cleanup_pending", bound);
    const released = event(5, "released", cleanupPending, {
      attestation_sha256: stableDigest(releasedAttestation),
    });

    expect(
      deriveWorkspaceLifecycle({
        binding: workspaceBinding,
        provider_events: [allocated, allocating, bound, cleanupPending, released],
        proof: proof(workspaceBinding),
        cleanup_attempts: [cleanupAttempt(workspaceBinding, releasedAttestation)],
        cleanup_receipt: cleanupReceipt(workspaceBinding, releasedAttestation),
      }).resource_state,
    ).toBe("released");
  });

  test("rejects a cleanup receipt contradicted by the terminal provider event", () => {
    const workspaceBinding = binding();
    const releasedAttestation = attestation("released", "2026-01-01T00:00:05.000Z");
    const allocated = event(1, "allocation_recorded", undefined);
    const allocating = event(2, "allocating", allocated);
    const bound = event(3, "bound", allocating);
    const blocked = event(4, "blocked", bound);

    expect(() =>
      deriveWorkspaceLifecycle({
        binding: workspaceBinding,
        provider_events: [allocated, allocating, bound, blocked],
        proof: proof(workspaceBinding),
        cleanup_receipt: cleanupReceipt(workspaceBinding, releasedAttestation),
      }),
    ).toThrow(/receipt contradicts the terminal provider event/);
  });

  test("rejects corruption and never derives cancellation from provider evidence alone", () => {
    const allocated = event(1, "allocation_recorded", undefined);
    const cancellation = event(2, "cancellation_outcome", allocated, {
      status: "cancelled",
    });
    const corrupt = { ...event(2, "bound", allocated), previous_sha256: "b".repeat(64) };
    expect(() => validateProviderEventChain([allocated, corrupt])).toThrow(/corrupt/);

    expect(
      deriveWorkspaceLifecycle({
        provider_events: [allocated],
        cancellation_outcome: { status: "cancelled" } as never,
      }).cancellation,
    ).toBe("none");
    expect(
      deriveWorkspaceLifecycle({
        provider_events: [allocated, cancellation],
        work_events: [{ event: "work.cancelled", seq: 4 } as never],
        workflow_journal: [
          {
            event: "workspace.cancel",
            status: "cancelled",
            work_event_seq: 4,
            work_event_sha256: stableDigest({ event: "work.cancelled", seq: 4 }),
          },
        ],
      }).cancellation,
    ).toBe("confirmed");
    expect(
      deriveWorkspaceLifecycle({
        provider_events: [allocated, cancellation],
        work_events: [
          { event: "work.cancelled", seq: 4 } as never,
          { event: "work.reopened", seq: 5 } as never,
        ],
        workflow_journal: [
          {
            event: "workspace.cancel",
            status: "cancelled",
            work_event_seq: 4,
            work_event_sha256: stableDigest({ event: "work.cancelled", seq: 4 }),
          },
        ],
      }).cancellation,
    ).toBe("none");
  });

  test("shared compatibility does not project as provider unsupported", () => {
    const manifest = {
      execution: { isolation: "shared" },
    } as WorkflowRunManifest;
    expect(deriveWorkspaceLifecycle({ manifest })).toMatchObject({
      state: "shared",
      workflow_outcome: null,
      resource_state: null,
      integration_state: "none",
    });
    expect(deriveWorkspaceLifecycle({})).toMatchObject({
      state: "unsupported",
      workflow_outcome: null,
      resource_state: null,
      integration_state: "none",
    });
  });
});
