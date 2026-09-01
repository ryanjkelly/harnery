import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeJobDigest, type QaRunJob } from "../lib/browser/qa-run-contracts.ts";
import { resolveAndAssess } from "./qa-verify.ts";

const TARGET = "http://localhost:9999/page";

/** The effective job qa-run would have validated for a jobless invocation. */
const EFFECTIVE_JOB: QaRunJob = { schema_version: 1, target: TARGET, mode: "review" };
const JOB_DIGEST = computeJobDigest(EFFECTIVE_JOB);

interface FixtureOverrides {
  run?: Record<string, unknown> | null;
  top?: Record<string, unknown>;
}

/** A minimal schema-v2 result document whose identity block points at outDir. */
function buildResult(outDir: string, overrides: FixtureOverrides = {}): Record<string, unknown> {
  const run =
    overrides.run === null
      ? undefined
      : {
          run_id: "11111111-2222-4333-8444-555555555555",
          started_at: "2026-09-01T12:00:00.000Z",
          completed_at: "2026-09-01T12:05:00.000Z",
          tested_revision: "deadbeefcafe",
          revision_source: "git",
          worktree_dirty: false,
          job_digest: JOB_DIGEST,
          out_dir: outDir,
          ...(overrides.run ?? {}),
        };
  return {
    schema_version: 2,
    ...(run !== undefined ? { run } : {}),
    target: TARGET,
    mode: "review",
    verdict: "passed",
    ...(overrides.top ?? {}),
  };
}

let root: string;

/** Create a run directory under root and write a result fixture into it. */
function writeRun(
  name: string,
  overrides: FixtureOverrides = {},
): {
  runDir: string;
  resultPath: string;
} {
  const runDir = join(root, name);
  mkdirSync(runDir, { recursive: true });
  const resultPath = join(runDir, "page-qa-result.json");
  writeFileSync(resultPath, JSON.stringify(buildResult(runDir, overrides), null, 2));
  return { runDir, resultPath };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qa-verify-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveAndAssess: path resolution", () => {
  test("a result file path is assessed directly", () => {
    const { resultPath } = writeRun("run-a");
    const outcome = resolveAndAssess(resultPath);
    expect(outcome.exit).toBe(0);
    expect(outcome.assessment?.fresh).toBe(true);
    expect(outcome.assessment?.verdict).toBe("passed");
    expect(outcome.resultPath).toBe(resultPath);
  });

  test("a run directory resolves its page-qa-result.json", () => {
    const { runDir, resultPath } = writeRun("run-b");
    const outcome = resolveAndAssess(runDir);
    expect(outcome.exit).toBe(0);
    expect(outcome.resultPath).toBe(resultPath);
  });

  test("a parent directory follows latest.json's result pointer", () => {
    const { resultPath } = writeRun("run-c");
    writeFileSync(
      join(root, "latest.json"),
      JSON.stringify({
        schema_version: 1,
        run_id: "11111111-2222-4333-8444-555555555555",
        dir: "run-c",
        result: join("run-c", "page-qa-result.json"),
        completed_at: "2026-09-01T12:05:00.000Z",
        verdict: "passed",
      }),
    );
    const outcome = resolveAndAssess(root);
    expect(outcome.exit).toBe(0);
    expect(outcome.resultPath).toBe(resultPath);
  });

  test("a directory with neither pointer nor result names both expectations", () => {
    const empty = join(root, "empty");
    mkdirSync(empty);
    const outcome = resolveAndAssess(empty);
    expect(outcome.exit).toBe(1);
    expect(outcome.error).toContain("latest.json");
    expect(outcome.error).toContain("page-qa-result.json");
  });

  test("a missing path is a usage error", () => {
    const outcome = resolveAndAssess(join(root, "does-not-exist.json"));
    expect(outcome.exit).toBe(1);
    expect(outcome.error).toContain("cannot access");
  });

  test("an unparseable result document is a usage error", () => {
    const path = join(root, "broken.json");
    writeFileSync(path, "{not json");
    const outcome = resolveAndAssess(path);
    expect(outcome.exit).toBe(1);
    expect(outcome.error).toContain("not valid JSON");
  });
});

describe("resolveAndAssess: identity and expectations", () => {
  test("a schema-v1 document is unverifiable (exit 3)", () => {
    const { resultPath } = writeRun("run-v1", { top: { schema_version: 1 }, run: null });
    const outcome = resolveAndAssess(resultPath);
    expect(outcome.exit).toBe(3);
    expect(outcome.assessment?.fresh).toBe(false);
    expect(outcome.assessment?.reasons.join(" ")).toContain("schema_version");
  });

  test("a v2 document without a run-identity block is unverifiable (exit 3)", () => {
    const { resultPath } = writeRun("run-no-id", { run: null });
    const outcome = resolveAndAssess(resultPath);
    expect(outcome.exit).toBe(3);
    expect(outcome.assessment?.reasons.join(" ")).toContain("run-identity");
  });

  test("a wrong run_id expectation is stale with a named reason", () => {
    const { resultPath } = writeRun("run-id");
    const outcome = resolveAndAssess(resultPath, { runId: "other-run-id" });
    expect(outcome.exit).toBe(3);
    expect(outcome.assessment?.reasons.some((reason) => reason.includes("run_id"))).toBe(true);
  });

  test("a wrong revision expectation is stale with a named reason", () => {
    const { resultPath } = writeRun("run-rev");
    const outcome = resolveAndAssess(resultPath, { revision: "0000000000" });
    expect(outcome.exit).toBe(3);
    expect(outcome.assessment?.reasons.some((reason) => reason.includes("tested_revision"))).toBe(
      true,
    );
  });

  test("a matching run_id and revision stay fresh", () => {
    const { resultPath } = writeRun("run-ok");
    const outcome = resolveAndAssess(resultPath, {
      runId: "11111111-2222-4333-8444-555555555555",
      revision: "deadbeefcafe",
    });
    expect(outcome.exit).toBe(0);
  });

  test("a moved or copied result is caught via found_in_dir", () => {
    const { runDir } = writeRun("run-original");
    const movedDir = join(root, "moved-elsewhere");
    mkdirSync(movedDir);
    const movedPath = join(movedDir, "page-qa-result.json");
    // Same document content, recorded out_dir still names the original home.
    writeFileSync(movedPath, JSON.stringify(buildResult(runDir), null, 2));
    const outcome = resolveAndAssess(movedPath);
    expect(outcome.exit).toBe(3);
    expect(outcome.assessment?.reasons.some((reason) => reason.includes("moved or copied"))).toBe(
      true,
    );
  });

  test("max-age marks an old run stale and honors the injected now", () => {
    const { resultPath } = writeRun("run-age");
    const fresh = resolveAndAssess(
      resultPath,
      { maxAge: "10" },
      { now: "2026-09-01T12:10:00.000Z" },
    );
    expect(fresh.exit).toBe(0);
    const stale = resolveAndAssess(
      resultPath,
      { maxAge: "1" },
      { now: "2026-09-01T12:10:00.000Z" },
    );
    expect(stale.exit).toBe(3);
    expect(stale.assessment?.reasons.some((reason) => reason.includes("maximum age"))).toBe(true);
  });

  test("a non-numeric max-age is a usage error", () => {
    const { resultPath } = writeRun("run-badage");
    const outcome = resolveAndAssess(resultPath, { maxAge: "soon" });
    expect(outcome.exit).toBe(1);
    expect(outcome.error).toContain("--max-age");
  });
});

describe("resolveAndAssess: job reconstruction", () => {
  test("a job file matching the recorded digest verifies fresh", () => {
    const { resultPath } = writeRun("run-job");
    const jobPath = join(root, "job.json");
    // The file omits target and mode; the result document supplies them,
    // reconstructing the same effective job qa-run digested.
    writeFileSync(jobPath, JSON.stringify({ schema_version: 1 }));
    const outcome = resolveAndAssess(resultPath, { job: jobPath });
    expect(outcome.exit).toBe(0);
  });

  test("a job file with different content is a digest mismatch (exit 3)", () => {
    const { resultPath } = writeRun("run-jobdiff");
    const jobPath = join(root, "job-diff.json");
    writeFileSync(
      jobPath,
      JSON.stringify({
        schema_version: 1,
        contexts: [{ id: "hd-dark-default", viewport: "hd", theme: "dark", state: "default" }],
      }),
    );
    const outcome = resolveAndAssess(resultPath, { job: jobPath });
    expect(outcome.exit).toBe(3);
    expect(outcome.assessment?.reasons.some((reason) => reason.includes("job_digest"))).toBe(true);
  });

  test("a job that fails validation lists its errors (exit 1)", () => {
    const { resultPath } = writeRun("run-jobbad");
    const jobPath = join(root, "job-bad.json");
    // No schema_version, so the reconstructed job cannot validate.
    writeFileSync(jobPath, JSON.stringify({ checks: "not-an-array" }));
    const outcome = resolveAndAssess(resultPath, { job: jobPath });
    expect(outcome.exit).toBe(1);
    expect(outcome.jobErrors?.length).toBeGreaterThan(0);
  });

  test("an unreadable job file is a usage error", () => {
    const { resultPath } = writeRun("run-jobmissing");
    const outcome = resolveAndAssess(resultPath, { job: join(root, "no-such-job.json") });
    expect(outcome.exit).toBe(1);
    expect(outcome.error).toContain("cannot read");
  });
});
