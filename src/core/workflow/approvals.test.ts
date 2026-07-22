import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicy, normalizePolicy, policyDigest } from "../policy/index.ts";
import {
  createWorkflowApproval,
  listWorkflowApprovals,
  readWorkflowApproval,
  resolveWorkflowApproval,
  workflowApprovalId,
} from "./approvals.ts";

let root: string;

beforeEach(() => {
  const tempRoot = process.platform === "linux" ? "/tmp" : tmpdir();
  root = join(tempRoot, `workflow-approval-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, ".harnery"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function request() {
  const policy = normalizePolicy({ network: "ask" });
  const summary = {
    phase: "dispatch" as const,
    action: "spawn agent",
    isolation: "shared" as const,
    network_access: "enabled" as const,
  };
  return {
    coordRoot: root,
    runId: "wf-fixture",
    decisionId: "p1",
    policy: { name: policy.name, sha256: policyDigest(policy) },
    request: summary,
    evaluation: evaluatePolicy(policy, summary),
    now: () => "2026-07-21T12:00:00.000Z",
  };
}

describe("durable workflow approvals", () => {
  test("creates a deterministic private pending request", () => {
    const created = createWorkflowApproval(request());
    expect(created.created).toBe(true);
    expect(created.approval.status).toBe("pending");
    expect(created.approval.request.id).toBe(workflowApprovalId("wf-fixture", "p1"));
    const path = join(root, ".harnery", "approvals", created.approval.request.id, "request.json");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("same decision is idempotent and a conflicting decision is refused", () => {
    const { approval } = createWorkflowApproval(request());
    const first = resolveWorkflowApproval({
      coordRoot: root,
      approvalId: approval.request.id,
      verdict: "allow",
      actor: "operator",
      now: () => "2026-07-21T12:01:00.000Z",
    });
    expect(first.applied).toBe(true);
    expect(first.approval.status).toBe("approved");
    const retry = resolveWorkflowApproval({
      coordRoot: root,
      approvalId: approval.request.id,
      verdict: "allow",
      actor: "another retry",
    });
    expect(retry.applied).toBe(false);
    expect(retry.approval.decision?.actor).toBe("operator");
    expect(() =>
      resolveWorkflowApproval({
        coordRoot: root,
        approvalId: approval.request.id,
        verdict: "deny",
        actor: "operator",
      }),
    ).toThrow(/conflicting denial refused/);
  });

  test("request drift cannot reuse an existing approval slot", () => {
    createWorkflowApproval(request());
    expect(() =>
      createWorkflowApproval({
        ...request(),
        request: { ...request().request, action: "different operation" },
      }),
    ).toThrow(/different policy request/);
  });

  test("refuses a persisted request whose policy-bound digest no longer matches", () => {
    const { approval } = createWorkflowApproval(request());
    const path = join(root, ".harnery", "approvals", approval.request.id, "request.json");
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    persisted.request.action = "tampered operation";
    writeFileSync(path, `${JSON.stringify(persisted)}\n`, "utf8");
    expect(() => readWorkflowApproval(root, approval.request.id)).toThrow(/mismatched request/);
  });

  test("lists and filters resolved records", () => {
    const { approval } = createWorkflowApproval(request());
    resolveWorkflowApproval({
      coordRoot: root,
      approvalId: approval.request.id,
      verdict: "deny",
      actor: "operator",
    });
    expect(listWorkflowApprovals(root, { status: "pending" })).toHaveLength(0);
    expect(listWorkflowApprovals(root, { status: "denied" })).toHaveLength(1);
    expect(readWorkflowApproval(root, approval.request.id).status).toBe("denied");
  });
});
