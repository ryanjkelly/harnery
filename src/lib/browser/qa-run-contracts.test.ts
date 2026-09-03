import { describe, expect, test } from "bun:test";
import type { QaManifest } from "./qa-plan.ts";
import {
  assessQaRunEvidence,
  computeJobDigest,
  computeVerdict,
  contextIdFor,
  mergeCoverage,
  QA_RUN_JOB_SCHEMA_VERSION,
  QA_RUN_RESULT_SCHEMA_VERSION,
  type QaRunBlocker,
  type QaRunCommandOutcome,
  type QaRunCritiqueOutcome,
  type QaRunJob,
  validateQaRunJob,
} from "./qa-run-contracts.ts";

function manifest(overrides: Partial<QaManifest> = {}): QaManifest {
  return {
    schema_version: 1,
    change_class: "large-structural",
    classification_reasons: ["test"],
    baseline_source: "none",
    scopes: [],
    contexts: [
      { viewport: "desktop", theme: "light", state: "default" },
      { viewport: "mobile", theme: "light", state: "default" },
      { viewport: "desktop", theme: "dark", state: "default" },
    ],
    checks: { deterministic: ["overflow"], interaction: [], visual: "full-page" },
    concurrency: { headless: 2, metered: 1 },
    reuse: { mode: "none", cache: false },
    predicted: { tiles_ceiling: 4, model_calls_ceiling: 12 },
    ...overrides,
  };
}

function validJob(overrides: Partial<QaRunJob> = {}): QaRunJob {
  return {
    schema_version: QA_RUN_JOB_SCHEMA_VERSION,
    target: "http://localhost:4276/page",
    mode: "review",
    ...overrides,
  };
}

function command(
  outcome: QaRunCommandOutcome["outcome"],
  overrides: Partial<QaRunCommandOutcome> = {},
): QaRunCommandOutcome {
  return {
    context_id: "desktop-light-default",
    check_id: "capture",
    argv: ["browse"],
    exit_code: outcome === "passed" ? 0 : outcome === "failed" ? 2 : null,
    outcome,
    failures: [],
    artifacts: {},
    wall_time_ms: 10,
    ...overrides,
  };
}

function critiqueOutcome(
  outcome: QaRunCritiqueOutcome["outcome"],
  overrides: Partial<QaRunCritiqueOutcome> = {},
): QaRunCritiqueOutcome {
  return {
    context_id: "desktop-light-default",
    provider: "headless",
    tiles_total: 3,
    tiles_reviewed: 3,
    tiles_reused: 0,
    outcome,
    findings: [],
    ...overrides,
  };
}

describe("validateQaRunJob", () => {
  test("policy.critique_max_tiles must be an integer between 1 and 400", () => {
    for (const bad of [0, 401, 2.5, "24"]) {
      const result = validateQaRunJob(validJob({ policy: { critique_max_tiles: bad as number } }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join("\n")).toContain("policy.critique_max_tiles");
      }
    }
    expect(validateQaRunJob(validJob({ policy: { critique_max_tiles: 40 } })).ok).toBe(true);
  });

  test("shared tile budget rejects impossible values before rendering", () => {
    for (const bad of [0, 7, 401, 9.5, "96", null]) {
      const result = validateQaRunJob(
        validJob({ policy: { critique_tile_budget: bad as number } }),
      );
      expect(result.ok).toBe(false);
    }
    for (const value of [8, 96, 400]) {
      expect(validateQaRunJob(validJob({ policy: { critique_tile_budget: value } })).ok).toBe(true);
    }
  });

  test("disposition acceptance is an explicit boolean and changes the proof identity", () => {
    for (const bad of ["false", "true", 0, 1, null]) {
      expect(
        validateQaRunJob(validJob({ policy: { accept_dispositions: bad as unknown as boolean } }))
          .ok,
      ).toBe(false);
    }
    const plain = validJob();
    expect(computeJobDigest(validJob({ policy: { accept_dispositions: false } }))).toBe(
      computeJobDigest(plain),
    );
    expect(computeJobDigest(validJob({ policy: { accept_dispositions: true } }))).not.toBe(
      computeJobDigest(plain),
    );
    expect(validateQaRunJob(validJob({ policy: { accept_dispositions: true } })).ok).toBe(true);
  });

  test("non-object policy is rejected", () => {
    for (const policy of [null, [], "", 3]) {
      expect(
        validateQaRunJob(validJob({ policy: policy as unknown as QaRunJob["policy"] })).ok,
      ).toBe(false);
    }
  });

  test("policy.review_pack_retention_minutes must be an integer between 1 and 43200", () => {
    for (const bad of [0, 43_201, 1.5, "90"]) {
      const result = validateQaRunJob(
        validJob({ policy: { review_pack_retention_minutes: bad as number } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join("\n")).toContain("policy.review_pack_retention_minutes");
      }
    }
    for (const ok of [1, 90, 43_200]) {
      expect(validateQaRunJob(validJob({ policy: { review_pack_retention_minutes: ok } })).ok).toBe(
        true,
      );
    }
  });

  test("a valid job round-trips", () => {
    const job = validJob({
      contexts: [{ id: "hd-dark-default", viewport: "hd", theme: "dark", state: "default" }],
      checks: [{ id: "overflow", args: ["--check-overflow", "--check-overflow-fail"] }],
      interaction_states: [
        { name: "menu-open", setup: ["--click", "#menu"], assertions: ["exists .menu-panel"] },
      ],
      qa_hints: { scopes: ["#main"], states: ["menu-open"] },
      policy: { command_concurrency: 3, command_timeout_ms: 60_000, run_deadline_ms: 600_000 },
    });
    const result = validateQaRunJob(job);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.job).toBe(job);
  });

  test("a secret-bearing field name is refused", () => {
    const result = validateQaRunJob({
      ...validJob(),
      api_key: "abc123",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("api_key"))).toBe(true);
      expect(result.errors.some((e) => e.includes("browser profile"))).toBe(true);
    }
  });

  test("a Bearer-shaped value is refused even under an innocent key", () => {
    const result = validateQaRunJob(
      validJob({
        checks: [
          {
            id: "auth-header",
            args: ["--evaluate", "Bearer abcdefghijklmnopqrstuvwxyz0123456789"],
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("looks like a credential"))).toBe(true);
    }
  });

  test("a sub-floor run deadline is refused", () => {
    const result = validateQaRunJob(validJob({ policy: { run_deadline_ms: 500 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("run_deadline_ms"))).toBe(true);
    }
  });

  test("an underspecified job reports every error at once", () => {
    const result = validateQaRunJob({
      schema_version: 99,
      mode: "yolo",
      checks: [{ id: "", args: [] }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("schema_version"))).toBe(true);
      expect(result.errors.some((e) => e.includes("target"))).toBe(true);
      expect(result.errors.some((e) => e.includes("mode"))).toBe(true);
      expect(result.errors.some((e) => e.includes("checks[0].id"))).toBe(true);
      expect(result.errors.some((e) => e.includes("checks[0].args"))).toBe(true);
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("mergeCoverage", () => {
  test("manifest contexts are always present, in manifest order, first", () => {
    const merged = mergeCoverage(
      manifest(),
      validJob({
        contexts: [{ id: "hd-dark-default", viewport: "hd", theme: "dark", state: "default" }],
      }),
    );
    expect(merged.map((c) => c.id)).toEqual([
      "desktop-light-default",
      "mobile-light-default",
      "desktop-dark-default",
      "hd-dark-default",
    ]);
  });

  test("a job can never narrow coverage below the manifest", () => {
    // A job that declares NO contexts (the narrowest possible input) still
    // yields the full manifest matrix.
    const merged = mergeCoverage(manifest(), validJob());
    expect(merged).toHaveLength(3);
    for (const context of manifest().contexts) {
      expect(merged.some((c) => c.id === contextIdFor(context))).toBe(true);
    }
  });

  test("a job duplicate of a manifest context is not appended twice", () => {
    const merged = mergeCoverage(
      manifest(),
      validJob({
        contexts: [
          { id: "desktop-light-default", viewport: "desktop", theme: "light", state: "default" },
        ],
      }),
    );
    expect(merged).toHaveLength(3);
  });
});

describe("computeVerdict", () => {
  test("failed beats incomplete", () => {
    expect(
      computeVerdict({
        mode: "review",
        blockers: [{ stage: "gates", reason: "one child died" }],
        commands: [command("failed"), command("unknown")],
        critique: [],
        snapshotSaved: false,
      }),
    ).toBe("failed");
  });

  test("any blocker makes the verdict incomplete", () => {
    expect(
      computeVerdict({
        mode: "review",
        blockers: [{ stage: "plan", reason: "manifest incomplete" }],
        commands: [command("passed")],
        critique: [],
        snapshotSaved: false,
      }),
    ).toBe("incomplete");
  });

  test("an unknown outcome makes the verdict incomplete", () => {
    expect(
      computeVerdict({
        mode: "review",
        blockers: [],
        commands: [command("passed"), command("unknown")],
        critique: [],
        snapshotSaved: false,
      }),
    ).toBe("incomplete");
    expect(
      computeVerdict({
        mode: "review",
        blockers: [],
        commands: [command("passed")],
        critique: [critiqueOutcome("unknown")],
        snapshotSaved: false,
      }),
    ).toBe("incomplete");
  });

  test("signoff without a persisted snapshot is incomplete", () => {
    expect(
      computeVerdict({
        mode: "signoff",
        blockers: [],
        commands: [command("passed")],
        critique: [critiqueOutcome("passed")],
        snapshotSaved: false,
      }),
    ).toBe("incomplete");
  });

  test("a clean review passes without a snapshot", () => {
    expect(
      computeVerdict({
        mode: "review",
        blockers: [],
        commands: [command("passed")],
        critique: [critiqueOutcome("passed")],
        snapshotSaved: false,
      }),
    ).toBe("passed");
  });
});

describe("computeJobDigest", () => {
  test("key insertion order never changes the digest, including nested objects", () => {
    const a: QaRunJob = {
      schema_version: QA_RUN_JOB_SCHEMA_VERSION,
      target: "http://localhost:4276/page",
      mode: "review",
      contexts: [{ id: "hd-dark-default", viewport: "hd", theme: "dark", state: "default" }],
      checks: [{ id: "overflow", args: ["--check-overflow"], contexts: ["hd-dark-default"] }],
      qa_hints: { scopes: ["#main"], states: ["menu-open"] },
    };
    const b: QaRunJob = {
      qa_hints: { states: ["menu-open"], scopes: ["#main"] },
      checks: [{ contexts: ["hd-dark-default"], args: ["--check-overflow"], id: "overflow" }],
      contexts: [{ state: "default", theme: "dark", viewport: "hd", id: "hd-dark-default" }],
      mode: "review",
      target: "http://localhost:4276/page",
      schema_version: QA_RUN_JOB_SCHEMA_VERSION,
    };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b)); // the reorder is real
    expect(computeJobDigest(b)).toBe(computeJobDigest(a));
  });

  test("a content change to target, mode, a context, or a check changes the digest", () => {
    const base = computeJobDigest(validJob());
    expect(computeJobDigest(validJob({ target: "http://localhost:4276/other" }))).not.toBe(base);
    expect(computeJobDigest(validJob({ mode: "signoff" }))).not.toBe(base);
    const withContext = validJob({
      contexts: [{ id: "hd-dark-default", viewport: "hd", theme: "dark", state: "default" }],
    });
    expect(computeJobDigest(withContext)).not.toBe(base);
    expect(
      computeJobDigest(validJob({ checks: [{ id: "overflow", args: ["--check-overflow"] }] })),
    ).not.toBe(base);
  });

  test("runtime policy differences never change the digest", () => {
    const base = computeJobDigest(validJob());
    expect(computeJobDigest(validJob({ policy: { command_concurrency: 8 } }))).toBe(base);
    expect(
      computeJobDigest(
        validJob({ policy: { allow_metered_critique: true, command_timeout_ms: 5_000 } }),
      ),
    ).toBe(base);
  });

  test("array order is semantic and changes the digest", () => {
    const first = {
      id: "a-light-default",
      viewport: "a",
      theme: "light" as const,
      state: "default",
    };
    const second = {
      id: "b-light-default",
      viewport: "b",
      theme: "light" as const,
      state: "default",
    };
    expect(computeJobDigest(validJob({ contexts: [first, second] }))).not.toBe(
      computeJobDigest(validJob({ contexts: [second, first] })),
    );
  });
});

describe("assessQaRunEvidence", () => {
  function resultDocument(runOverrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema_version: QA_RUN_RESULT_SCHEMA_VERSION,
      run: {
        run_id: "run-1",
        started_at: "2026-09-01T10:00:00.000Z",
        completed_at: "2026-09-01T10:05:00.000Z",
        tested_revision: "abc123",
        revision_source: "job",
        job_digest: "digest-1",
        out_dir: "/tmp/out/run-run-1",
        ...runOverrides,
      },
      verdict: "passed",
    };
  }

  test("a complete fresh v2 document with matching expectations is fresh", () => {
    const assessment = assessQaRunEvidence(resultDocument(), {
      run_id: "run-1",
      job_digest: "digest-1",
      tested_revision: "abc123",
      not_started_before: "2026-09-01T09:59:00.000Z",
      max_age_ms: 60_000,
      now: "2026-09-01T10:05:30.000Z",
      found_in_dir: "/tmp/out/run-run-1",
    });
    expect(assessment.fresh).toBe(true);
    expect(assessment.reasons).toEqual([]);
    expect(assessment.run?.run_id).toBe("run-1");
    expect(assessment.verdict).toBe("passed");
  });

  test("schema_version 1 is stale — pre-identity results carry nothing to verify", () => {
    const assessment = assessQaRunEvidence({ ...resultDocument(), schema_version: 1 });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain("pre-identity");
  });

  test("a missing run block is stale", () => {
    const { run: _run, ...withoutRun } = resultDocument();
    const assessment = assessQaRunEvidence(withoutRun);
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain("run-identity");
  });

  test("a run_id mismatch produces exactly its reason", () => {
    const assessment = assessQaRunEvidence(resultDocument(), { run_id: "run-2" });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain("run_id run-1 is not the expected run-2");
  });

  test("a job_digest mismatch produces exactly its reason", () => {
    const assessment = assessQaRunEvidence(resultDocument(), { job_digest: "digest-2" });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain("job_digest");
  });

  test("a tested_revision mismatch produces exactly its reason", () => {
    const assessment = assessQaRunEvidence(resultDocument(), { tested_revision: "def456" });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain("tested_revision abc123 is not the expected def456");
  });

  test('revision_source "unknown" can never satisfy a revision expectation', () => {
    const document = resultDocument({ revision_source: "unknown" });
    delete (document.run as Record<string, unknown>).tested_revision;
    const assessment = assessQaRunEvidence(document, { tested_revision: "abc123" });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain('revision_source "unknown"');
  });

  test("a run started before the freshness floor produces exactly its reason", () => {
    const assessment = assessQaRunEvidence(resultDocument(), {
      not_started_before: "2026-09-01T10:30:00.000Z",
    });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain("freshness floor");
  });

  test("a run older than max_age_ms against an explicit now produces exactly its reason", () => {
    const assessment = assessQaRunEvidence(resultDocument(), {
      max_age_ms: 60_000,
      now: "2026-09-01T11:00:00.000Z",
    });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain("60000ms maximum age");
  });

  test("a found_in_dir mismatch produces exactly the moved-result reason", () => {
    const assessment = assessQaRunEvidence(resultDocument(), {
      found_in_dir: "/tmp/elsewhere/run-run-1",
    });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(1);
    expect(assessment.reasons[0]).toContain("moved or copied");
  });

  test("multiple mismatches are all reported, not just the first", () => {
    const assessment = assessQaRunEvidence(resultDocument(), {
      run_id: "run-2",
      job_digest: "digest-2",
      tested_revision: "def456",
      found_in_dir: "/tmp/elsewhere",
    });
    expect(assessment.fresh).toBe(false);
    expect(assessment.reasons).toHaveLength(4);
  });

  test("non-object input is stale", () => {
    for (const input of [null, undefined, "passed", 42, ["passed"]]) {
      const assessment = assessQaRunEvidence(input);
      expect(assessment.fresh).toBe(false);
      expect(assessment.reasons).toEqual(["document is not a result object"]);
    }
  });
});

describe("computeVerdict evidence source", () => {
  const clean = (): {
    blockers: QaRunBlocker[];
    commands: QaRunCommandOutcome[];
    critique: QaRunCritiqueOutcome[];
    snapshotSaved: boolean;
  } => ({ blockers: [], commands: [], critique: [], snapshotSaved: true });

  test("manual evidence never reads passed, however clean", () => {
    expect(computeVerdict({ mode: "review", ...clean(), evidenceSource: "manual" })).toBe(
      "incomplete",
    );
    expect(computeVerdict({ mode: "signoff", ...clean(), evidenceSource: "manual" })).toBe(
      "incomplete",
    );
  });

  test("manual evidence still reports a defect it did find", () => {
    expect(
      computeVerdict({
        mode: "review",
        blockers: [],
        commands: [
          {
            context_id: "desktop-light-default",
            check_id: "manual:overflow",
            argv: ["<manual>"],
            exit_code: null,
            outcome: "failed",
            failures: ["horizontal overflow at 375px"],
            artifacts: {},
            wall_time_ms: 0,
          },
        ],
        critique: [],
        snapshotSaved: false,
        evidenceSource: "manual",
      }),
    ).toBe("failed");
  });

  test("runner evidence is unaffected by the cap", () => {
    expect(computeVerdict({ mode: "review", ...clean(), evidenceSource: "runner" })).toBe("passed");
    expect(computeVerdict({ mode: "review", ...clean() })).toBe("passed");
  });
});
