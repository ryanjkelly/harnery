import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginWorkflowRecovery, readWorkflowRecoveryLedger } from "./recovery-audit.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-recovery-audit-"));
  roots.push(root);
  const audit = beginWorkflowRecovery(root, {
    run_id: "wf-recovery",
    action: "unlock_resume",
    actor: "operator",
    reason: "Owner exited.",
    target_sha256: "a".repeat(64),
    target: { lock: "resume.lock" },
  });
  return {
    root,
    audit,
    intent: join(
      root,
      ".harnery",
      "workflows",
      "wf-recovery",
      "recovery",
      audit.intent.operation_id,
      "intent.json",
    ),
  };
}

describe("workflow recovery ledger", () => {
  test("durable intent reports unknown until matching completion exists", () => {
    const { root, audit, intent } = fixture();
    expect(JSON.parse(readFileSync(intent, "utf8"))).toMatchObject({
      actor: "operator",
      reason: "Owner exited.",
      outcome: "unknown",
      action: "unlock_resume",
    });
    expect(readWorkflowRecoveryLedger(root, "wf-recovery")).toEqual([
      { intent: audit.intent, outcome: "unknown" },
    ]);
    audit.complete();
    expect(readWorkflowRecoveryLedger(root, "wf-recovery")[0]?.outcome).toBe("completed");
  });
  test("changed audit authority prevents completion and cannot report success", () => {
    const { root, audit, intent } = fixture();
    writeFileSync(intent, JSON.stringify({ ...audit.intent, actor: "replacement" }));
    expect(() => audit.assertCurrent()).toThrow("audit authority changed");
    expect(() => audit.complete()).toThrow("audit authority changed");
    expect(readWorkflowRecoveryLedger(root, "wf-recovery")[0]?.outcome).toBe("unknown");
  });
  test("completion with different intent authority is refused", () => {
    const { root, audit, intent } = fixture();
    audit.complete();
    const path = join(intent, "..", "completion.json");
    const completion = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...completion, intent_sha256: "b".repeat(64) }));
    expect(() => readWorkflowRecoveryLedger(root, "wf-recovery")).toThrow("completion authority");
  });
  for (const authorization of [
    { actor: "", reason: "reason" },
    { actor: "operator", reason: "" },
    { actor: "operator", reason: "bad\nreason" },
  ]) {
    test(`refuses invalid recovery authority ${JSON.stringify(authorization)}`, () => {
      const { root } = fixture();
      expect(() =>
        beginWorkflowRecovery(root, {
          ...authorization,
          run_id: "wf-other",
          action: "unlock_resume",
          target_sha256: "a".repeat(64),
          target: {},
        }),
      ).toThrow("workflow recovery requires");
      expect(readWorkflowRecoveryLedger(root, "wf-other")).toEqual([]);
    });
  }
});
