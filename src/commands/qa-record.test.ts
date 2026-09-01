import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessQaRunEvidence } from "../lib/browser/qa-run-contracts.ts";
import {
  QA_RECORD_EVIDENCE_SCHEMA_VERSION,
  type QaManualEvidence,
  recordManualQa,
  validateManualEvidence,
} from "./qa-record.ts";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "harnery-qa-record-"));
}

function writeEvidence(dir: string, document: unknown): string {
  const path = join(dir, "evidence.json");
  writeFileSync(path, JSON.stringify(document, null, 2));
  return path;
}

function baseEvidence(overrides: Partial<QaManualEvidence> = {}): QaManualEvidence {
  return {
    schema_version: QA_RECORD_EVIDENCE_SCHEMA_VERSION,
    recorded_by: "agent-Test",
    reason: "the browser bridge dropped mid-matrix and would not reconnect",
    checks: [
      {
        context_id: "desktop-light-default",
        check_id: "manual:overflow",
        outcome: "passed",
        notes: ["no horizontal scrollbar at 1440 wide"],
        wall_time_ms: 1200,
      },
    ],
    contexts: [
      { id: "desktop-light-default", viewport: "desktop", theme: "light", state: "default" },
    ],
    ...overrides,
  };
}

const noRevision = () => undefined;

describe("validateManualEvidence", () => {
  test("reports every structural error at once", () => {
    const dir = workspace();
    const validation = validateManualEvidence(
      {
        schema_version: 9,
        checks: [{ check_id: "manual:x", outcome: "maybe" }],
      },
      { baseDir: dir },
    );
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    const joined = validation.errors.join("\n");
    expect(validation.errors.length).toBeGreaterThanOrEqual(5);
    expect(joined).toContain("schema_version must be 1");
    expect(joined).toContain("recorded_by is required");
    expect(joined).toContain("reason is required");
    expect(joined).toContain("checks[0].context_id is required");
    expect(joined).toContain("checks[0].outcome must be");
  });

  test("refuses a record with no stated reason", () => {
    const dir = workspace();
    const { reason: _reason, ...withoutReason } = baseEvidence();
    const validation = validateManualEvidence(withoutReason, { baseDir: dir });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors.join("\n")).toContain("reason is required");
  });

  test("refuses a record with no checks", () => {
    const dir = workspace();
    const validation = validateManualEvidence(baseEvidence({ checks: [] }), { baseDir: dir });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors.join("\n")).toContain("checks must be a non-empty array");
  });

  test("refuses an artifact path that is not on disk", () => {
    const dir = workspace();
    const evidence = baseEvidence({
      checks: [
        {
          context_id: "desktop-light-default",
          check_id: "manual:overflow",
          outcome: "passed",
          artifacts: { png: "missing-shot.png" },
        },
      ],
    });
    const validation = validateManualEvidence(evidence, { baseDir: dir });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors.join("\n")).toContain("does not exist on disk");
  });

  test("accepts an artifact path relative to the evidence directory", () => {
    const dir = workspace();
    writeFileSync(join(dir, "shot.png"), "png");
    const evidence = baseEvidence({
      checks: [
        {
          context_id: "desktop-light-default",
          check_id: "manual:overflow",
          outcome: "passed",
          artifacts: { png: "shot.png" },
        },
      ],
    });
    expect(validateManualEvidence(evidence, { baseDir: dir }).ok).toBe(true);
  });

  test("refuses a secret-bearing field", () => {
    const dir = workspace();
    const evidence = {
      ...baseEvidence(),
      session: { api_key: "abc123" },
    };
    const validation = validateManualEvidence(evidence, { baseDir: dir });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    const joined = validation.errors.join("\n");
    expect(joined).toContain("secret-bearing field names are refused");
    expect(joined).toContain("evidence.session.api_key");
  });
});

describe("recordManualQa", () => {
  test("a clean record is incomplete, manual, and carries the validate blocker", () => {
    const dir = workspace();
    const evidencePath = writeEvidence(dir, baseEvidence());
    const outDir = join(dir, ".qa-run");
    const outcome = recordManualQa({
      target: "https://example.test/pricing",
      evidencePath,
      outDir,
      revisionProbe: noRevision,
    });

    expect(outcome.exit).toBe(4);
    const result = outcome.result;
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.verdict).toBe("incomplete");
    expect(result.evidence_source).toBe("manual");
    expect(result.schema_version).toBe(3);
    expect(result.last_completed_stage).toBeNull();
    expect(result.qa_plan).toBeNull();
    expect(result.snapshot).toEqual({ saved: false });
    expect(result.critique).toEqual([]);
    expect(result.wall_time_ms.total).toBe(1200);
    expect(result.wall_time_ms.queue).toBeUndefined();
    expect(result.commands[0]?.argv).toEqual(["<manual>"]);
    expect(result.commands[0]?.exit_code).toBeNull();
    expect(result.run.revision_source).toBe("unknown");
    expect(result.run.out_dir.startsWith(outDir)).toBe(true);

    const blocker = result.blockers.find((entry) => entry.stage === "validate");
    expect(blocker).toBeDefined();
    expect(blocker?.reason).toContain("recorded by hand");
    expect(blocker?.reason).toContain("bridge dropped");
    expect(blocker?.reason).toContain("cannot read passed");
  });

  test("a failed check yields verdict failed and exit 2", () => {
    const dir = workspace();
    const evidencePath = writeEvidence(
      dir,
      baseEvidence({
        checks: [
          {
            context_id: "desktop-light-default",
            check_id: "manual:overflow",
            outcome: "failed",
            notes: ["hero image overflows by 40px at 1440 wide"],
            wall_time_ms: 800,
          },
          {
            context_id: "desktop-light-default",
            check_id: "manual:contrast",
            outcome: "passed",
            wall_time_ms: 200,
          },
        ],
      }),
    );
    const outcome = recordManualQa({
      target: "https://example.test/pricing",
      evidencePath,
      outDir: join(dir, ".qa-run"),
      revisionProbe: noRevision,
    });
    expect(outcome.exit).toBe(2);
    expect(outcome.result?.verdict).toBe("failed");
    expect(outcome.result?.wall_time_ms.total).toBe(1000);
    expect(outcome.result?.commands[0]?.failures).toEqual([
      "hero image overflows by 40px at 1440 wide",
    ]);
  });

  test("the written result passes assessQaRunEvidence in its own directory", () => {
    const dir = workspace();
    const evidencePath = writeEvidence(dir, baseEvidence());
    const outcome = recordManualQa({
      target: "https://example.test/pricing",
      evidencePath,
      outDir: join(dir, ".qa-run"),
      revisionProbe: noRevision,
    });
    const paths = outcome.paths;
    expect(paths).toBeDefined();
    if (!paths) return;

    const document = JSON.parse(readFileSync(paths.resultPath, "utf8"));
    const assessment = assessQaRunEvidence(document, {
      found_in_dir: paths.runDir,
      run_id: outcome.result?.run.run_id,
    });
    expect(assessment.reasons).toEqual([]);
    expect(assessment.fresh).toBe(true);
    expect(assessment.verdict).toBe("incomplete");

    const moved = assessQaRunEvidence(document, { found_in_dir: join(dir, "elsewhere") });
    expect(moved.fresh).toBe(false);
  });

  test("writes latest.json, run-status.json, and the source evidence", () => {
    const dir = workspace();
    const evidencePath = writeEvidence(dir, baseEvidence());
    const outDir = join(dir, ".qa-run");
    const outcome = recordManualQa({
      target: "https://example.test/pricing",
      evidencePath,
      outDir,
      revisionProbe: noRevision,
    });
    const paths = outcome.paths;
    expect(paths).toBeDefined();
    if (!paths) return;

    const pointer = JSON.parse(readFileSync(join(outDir, "latest.json"), "utf8"));
    expect(pointer.run_id).toBe(outcome.result?.run.run_id);
    expect(pointer.verdict).toBe("incomplete");
    expect(pointer.result).toBe(join(`run-${outcome.result?.run.run_id}`, "page-qa-result.json"));

    const status = JSON.parse(readFileSync(paths.statusPath, "utf8"));
    expect(status.state).toBe("completed");
    expect(status.stage).toBeNull();
    expect(status.verdict).toBe("incomplete");
    expect(status.run_id).toBe(outcome.result?.run.run_id);

    const copied = JSON.parse(readFileSync(paths.evidencePath, "utf8"));
    expect(copied.recorded_by).toBe("agent-Test");
  });

  test("derives contexts from check IDs when the document declares none", () => {
    const dir = workspace();
    const { contexts: _contexts, ...withoutContexts } = baseEvidence({
      checks: [
        { context_id: "mobile-dark-menu-open", check_id: "manual:menu", outcome: "unknown" },
        { context_id: "freeform", check_id: "manual:other", outcome: "passed" },
      ],
    });
    const evidencePath = writeEvidence(dir, withoutContexts);
    const outcome = recordManualQa({
      target: "https://example.test/pricing",
      evidencePath,
      outDir: join(dir, ".qa-run"),
      revisionProbe: noRevision,
    });
    expect(outcome.result?.contexts).toEqual([
      { id: "mobile-dark-menu-open", viewport: "mobile", theme: "dark", state: "menu-open" },
      { id: "freeform", viewport: "unknown", theme: "light", state: "default" },
    ]);
  });

  test("an unreadable evidence file is a usage error, and nothing is written", () => {
    const dir = workspace();
    const outcome = recordManualQa({
      target: "https://example.test/pricing",
      evidencePath: join(dir, "nope.json"),
      outDir: join(dir, ".qa-run"),
      revisionProbe: noRevision,
    });
    expect(outcome.exit).toBe(1);
    expect(outcome.paths).toBeUndefined();
    expect(outcome.error).toContain("cannot read --evidence file");
  });

  test("validation failure reports every error and writes nothing", () => {
    const dir = workspace();
    const evidencePath = writeEvidence(dir, {
      schema_version: 1,
      checks: [{ context_id: "c", check_id: "manual:x", outcome: "passed" }],
    });
    const outDir = join(dir, ".qa-run");
    const outcome = recordManualQa({
      target: "https://example.test/pricing",
      evidencePath,
      outDir,
      revisionProbe: noRevision,
    });
    expect(outcome.exit).toBe(1);
    expect(outcome.paths).toBeUndefined();
    expect(outcome.evidenceErrors?.length).toBe(2);
    expect(() => readFileSync(join(outDir, "latest.json"), "utf8")).toThrow();
  });

  test("records the git revision when the probe resolves one", () => {
    const dir = workspace();
    const evidencePath = writeEvidence(dir, baseEvidence());
    const outcome = recordManualQa({
      target: "https://example.test/pricing",
      evidencePath,
      outDir: join(dir, ".qa-run"),
      revisionProbe: () => ({ tested_revision: "abc1234", worktree_dirty: true }),
    });
    expect(outcome.result?.run.revision_source).toBe("git");
    expect(outcome.result?.run.tested_revision).toBe("abc1234");
    expect(outcome.result?.tested_revision).toBe("abc1234");
    expect(outcome.result?.run.worktree_dirty).toBe(true);
  });
});
