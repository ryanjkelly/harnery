// Regression tests for the reused-output-directory trap: an old passing
// result sitting in a parent directory must never read as evidence for the
// invocation happening now. Every run claims its own `run-<id>/` directory,
// the parent pointer follows the newest run, and evidence assessment is
// fail-closed on age, identity, location, and schema version. The admission
// case proves the evidence trail survives contention rather than vanishing
// with it.

import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAndAssess } from "../../commands/qa-verify.ts";
import type { QaManifest } from "./qa-plan.ts";
import {
  QA_RUN_LATEST_FILENAME,
  QA_RUN_RESULT_FILENAME,
  type QaRunExec,
  runQaMatrix,
} from "./qa-run.ts";
import {
  assessQaRunEvidence,
  QA_RUN_JOB_SCHEMA_VERSION,
  type QaRunJob,
  type QaRunResult,
} from "./qa-run-contracts.ts";

const BROWSE_ARGV = ["node", "/cli/harn.ts", "browse"];

/** The incident's gap: a passing result found in a reused directory that was
 * most of a day old. */
const THIRTEEN_HOURS_MS = 13 * 60 * 60 * 1000;

function outParentDir(): string {
  return mkdtempSync(join(tmpdir(), "qa-evidence-test-"));
}

function argvValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function manifest(overrides: Partial<QaManifest> = {}): QaManifest {
  return {
    schema_version: 1,
    change_class: "large-structural",
    classification_reasons: ["test"],
    baseline_source: "none",
    scopes: [],
    contexts: [{ viewport: "desktop", theme: "light", state: "default" }],
    checks: { deterministic: ["overflow"], interaction: [], visual: "none" },
    concurrency: { headless: 2, metered: 1 },
    reuse: { mode: "none", cache: false },
    predicted: { tiles_ceiling: 4, model_calls_ceiling: 12 },
    ...overrides,
  };
}

function job(overrides: Partial<QaRunJob> = {}): QaRunJob {
  return {
    schema_version: QA_RUN_JOB_SCHEMA_VERSION,
    target: "http://localhost:4276/page",
    mode: "review",
    ...overrides,
  };
}

/** Passing executor: the planner returns the manifest, every capture writes
 * its envelope and exits 0. */
function makePassingExec(planManifest: QaManifest): { exec: QaRunExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: QaRunExec = async (argv: string[]) => {
    calls.push(argv);
    if (argv.includes("--qa-plan")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ qaPlan: { manifest: planManifest } }),
        stderr: "",
      };
    }
    const outPrefix = argvValue(argv, "--out");
    if (outPrefix === undefined) return { exitCode: 1, stdout: "", stderr: "", error: "no --out" };
    writeFileSync(`${outPrefix}.json`, JSON.stringify({}));
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

function readResult(path: string): QaRunResult {
  return JSON.parse(readFileSync(path, "utf8")) as QaRunResult;
}

function readPointer(parent: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(parent, QA_RUN_LATEST_FILENAME), "utf8")) as Record<
    string,
    unknown
  >;
}

/** Run one passing matrix into `parent` and return its run directory. */
async function runInto(parent: string, runId: string, theJob: QaRunJob): Promise<string> {
  const { exec } = makePassingExec(manifest());
  const result = await runQaMatrix({
    job: theJob,
    outParent: parent,
    browseArgv: BROWSE_ARGV,
    exec,
    runId,
  });
  expect(result.verdict).toBe("passed");
  return join(parent, `run-${runId}`);
}

describe("reusing a qa-run output parent", () => {
  test("a second run into the same parent leaves the earlier run untouched and repoints latest.json", async () => {
    const parent = outParentDir();
    const oldDir = await runInto(parent, "old", job());
    const oldResultPath = join(oldDir, QA_RUN_RESULT_FILENAME);
    const oldBytes = readFileSync(oldResultPath, "utf8");
    const oldMtimeMs = statSync(oldResultPath).mtimeMs;
    const oldResult = readResult(oldResultPath);

    const newDir = await runInto(parent, "new", job());
    const newResult = readResult(join(newDir, QA_RUN_RESULT_FILENAME));

    // The old run is still exactly where and what it was.
    expect(existsSync(oldResultPath)).toBe(true);
    expect(readFileSync(oldResultPath, "utf8")).toBe(oldBytes);
    expect(statSync(oldResultPath).mtimeMs).toBe(oldMtimeMs);

    // The new run owns a different identity and a different directory.
    expect(newResult.run.run_id).not.toBe(oldResult.run.run_id);
    expect(newResult.run.out_dir).toBe(newDir);
    expect(newDir).not.toBe(oldDir);

    // And the parent pointer names the new run, not the old one.
    const pointer = readPointer(parent);
    expect(pointer.run_id).toBe("new");
    expect(pointer.dir).toBe("run-new");
    expect(pointer.result).toBe(join("run-new", QA_RUN_RESULT_FILENAME));
    expect(pointer.completed_at).toBe(newResult.run.completed_at);
  });

  test("an old result is rejected once it is older than the caller's maximum age", async () => {
    const parent = outParentDir();
    const oldDir = await runInto(parent, "aged", job());
    const oldResult = readResult(join(oldDir, QA_RUN_RESULT_FILENAME));
    const thirteenHoursLater = new Date(
      Date.parse(oldResult.run.completed_at) + THIRTEEN_HOURS_MS,
    ).toISOString();

    const assessment = assessQaRunEvidence(oldResult, {
      max_age_ms: 60 * 60 * 1000,
      now: thirteenHoursLater,
      found_in_dir: oldDir,
    });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain("older than");
    // The document is intact and still says "passed" — age alone disqualifies it.
    expect(assessment.verdict).toBe("passed");

    const outcome = resolveAndAssess(oldDir, { maxAge: "60" }, { now: thirteenHoursLater });
    expect(outcome.exit).toBe(3);
    expect(outcome.assessment?.fresh).toBe(false);

    // The same document inside its own freshness window verifies.
    const withinWindow = resolveAndAssess(
      oldDir,
      { maxAge: "60" },
      { now: oldResult.run.completed_at },
    );
    expect(withinWindow.exit).toBe(0);
    expect(withinWindow.assessment?.fresh).toBe(true);
  });

  test("an old result is rejected when the caller expects the new run's id", async () => {
    const parent = outParentDir();
    const oldDir = await runInto(parent, "previous", job());
    const newDir = await runInto(parent, "current", job());
    const newResult = readResult(join(newDir, QA_RUN_RESULT_FILENAME));

    const stale = resolveAndAssess(oldDir, { runId: newResult.run.run_id });
    expect(stale.exit).toBe(3);
    expect(stale.assessment?.fresh).toBe(false);
    expect(stale.assessment?.reasons.some((reason) => reason.includes("previous"))).toBe(true);

    // Following the parent pointer reaches the current run, which verifies.
    const current = resolveAndAssess(parent, { runId: newResult.run.run_id });
    expect(current.exit).toBe(0);
    expect(current.resultPath).toBe(join(newDir, QA_RUN_RESULT_FILENAME));
  });

  test("a result copied into another directory is not evidence for its new location", async () => {
    const parent = outParentDir();
    const runDir = await runInto(parent, "copied", job());
    const elsewhere = outParentDir();
    copyFileSync(join(runDir, QA_RUN_RESULT_FILENAME), join(elsewhere, QA_RUN_RESULT_FILENAME));

    const outcome = resolveAndAssess(join(elsewhere, QA_RUN_RESULT_FILENAME));
    expect(outcome.exit).toBe(3);
    expect(outcome.assessment?.fresh).toBe(false);
    expect(outcome.assessment?.reasons.some((reason) => reason.includes("moved or copied"))).toBe(
      true,
    );

    // In its own directory the identical document still verifies.
    expect(resolveAndAssess(runDir).exit).toBe(0);
  });

  test("a schema v2 result is rejected as unverifiable rather than read as evidence", async () => {
    const parent = outParentDir();
    const runDir = await runInto(parent, "legacy-shape", job());
    const current = readResult(join(runDir, QA_RUN_RESULT_FILENAME));

    // Same passing content, previous schema version, written into its own
    // directory so nothing but the version can be the reason it fails.
    const legacyDir = join(parent, "run-v2");
    mkdirSync(legacyDir, { recursive: true });
    const legacy = {
      ...current,
      schema_version: 2,
      run: { ...current.run, run_id: "v2", out_dir: legacyDir },
    };
    writeFileSync(join(legacyDir, QA_RUN_RESULT_FILENAME), `${JSON.stringify(legacy, null, 2)}\n`);

    const assessment = assessQaRunEvidence(legacy, { found_in_dir: legacyDir });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain("schema_version");
    // Fail-closed: no verdict is surfaced from an unverifiable document.
    expect(assessment.verdict).toBeUndefined();

    const outcome = resolveAndAssess(legacyDir);
    expect(outcome.exit).toBe(3);
    expect(outcome.assessment?.fresh).toBe(false);
  });

  test("a prior passing result never satisfies a verification aimed at a new invocation", async () => {
    const parent = outParentDir();
    const priorDir = await runInto(parent, "prior-pass", job());
    const prior = readResult(join(priorDir, QA_RUN_RESULT_FILENAME));
    expect(prior.verdict).toBe("passed");

    // The caller is about to launch a new run and already knows its id. The
    // parent still holds only the prior pass; resolution finds it, and the
    // identity check refuses it despite the green verdict.
    const outcome = resolveAndAssess(parent, { runId: "invocation-not-yet-run" });
    expect(outcome.resultPath).toBe(join(priorDir, QA_RUN_RESULT_FILENAME));
    expect(outcome.assessment?.verdict).toBe("passed");
    expect(outcome.assessment?.fresh).toBe(false);
    expect(outcome.exit).toBe(3);
    expect(
      outcome.assessment?.reasons.some((reason) => reason.includes("invocation-not-yet-run")),
    ).toBe(true);
  });
});

describe("qa-run evidence under resource pressure", () => {
  test("an unavailable admission slot still writes a result document and latest.json", async () => {
    const parent = outParentDir();
    const { exec, calls } = makePassingExec(manifest());
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "queue-full",
      admission: {
        resource: "browser-qa",
        acquire: async () => {
          throw new Error("no browser-qa slot became free within 3s; current holder(s): peer");
        },
      },
    });

    expect(result.verdict).toBe("incomplete");
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.stage).toBe("admission");
    expect(result.blockers[0]?.reason).toContain("no browser-qa slot");
    // Contention means no browser work happened at all.
    expect(calls).toHaveLength(0);
    expect(result.commands).toHaveLength(0);

    // But the evidence trail survives it: a readable result plus a pointer.
    const runDir = join(parent, "run-queue-full");
    const written = readResult(join(runDir, QA_RUN_RESULT_FILENAME));
    expect(written.run.run_id).toBe("queue-full");
    expect(written.verdict).toBe("incomplete");
    const pointer = readPointer(parent);
    expect(pointer.run_id).toBe("queue-full");
    expect(pointer.verdict).toBe("incomplete");

    // And the incomplete run is verifiable evidence of itself.
    const outcome = resolveAndAssess(parent, { runId: "queue-full" });
    expect(outcome.exit).toBe(0);
    expect(outcome.assessment?.verdict).toBe("incomplete");
  });

  test("a queue-blocked run never lets an earlier pass in the same parent stand in for it", async () => {
    const parent = outParentDir();
    await runInto(parent, "earlier-pass", job());
    const { exec } = makePassingExec(manifest());
    const blocked = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "blocked",
      admission: {
        resource: "browser-qa",
        acquire: async () => {
          throw new Error("no browser-qa slot became free within 3s; current holder(s): peer");
        },
      },
    });
    expect(blocked.verdict).toBe("incomplete");

    // latest.json follows the blocked run, so the parent no longer presents
    // the earlier pass as the current answer.
    const pointer = readPointer(parent);
    expect(pointer.run_id).toBe("blocked");
    const outcome = resolveAndAssess(parent, { runId: "blocked" });
    expect(outcome.exit).toBe(0);
    expect(outcome.assessment?.verdict).toBe("incomplete");
  });
});
