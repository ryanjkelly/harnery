import { describe, expect, test } from "bun:test";
import type { QaManifest } from "./qa-plan.ts";
import {
  computeVerdict,
  contextIdFor,
  mergeCoverage,
  QA_RUN_JOB_SCHEMA_VERSION,
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
  test("a valid job round-trips", () => {
    const job = validJob({
      contexts: [{ id: "hd-dark-default", viewport: "hd", theme: "dark", state: "default" }],
      checks: [{ id: "overflow", args: ["--check-overflow", "--check-overflow-fail"] }],
      interaction_states: [
        { name: "menu-open", setup: ["--click", "#menu"], assertions: ["exists .menu-panel"] },
      ],
      qa_hints: { scopes: ["#main"], states: ["menu-open"] },
      policy: { command_concurrency: 3, command_timeout_ms: 60_000 },
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
