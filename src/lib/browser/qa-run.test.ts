import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QaManifest } from "./qa-plan.ts";
import {
  QA_RUN_HEADLESS_ONLY_ENV,
  type QaRunExec,
  type QaRunExecOptions,
  type QaRunExecResult,
  runQaMatrix,
} from "./qa-run.ts";
import { QA_RUN_JOB_SCHEMA_VERSION, type QaRunJob } from "./qa-run-contracts.ts";

const BROWSE_ARGV = ["node", "/cli/harn.ts", "browse"];

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

function outDir(): string {
  return mkdtempSync(join(tmpdir(), "qa-run-test-"));
}

function argvValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function ok(): QaRunExecResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

interface FakeExecConfig {
  planManifest: QaManifest | null;
  /** Per-gate exit code by context id (default 0). */
  gateExit?: Record<string, number>;
  /** Per-gate hard failure by context id (spawn error / timeout). */
  gateError?: Record<string, string>;
  /** Per-gate browse envelope fields by context id. */
  gateEnvelope?: Record<string, Record<string, unknown>>;
  /** Async delay per gate context id, to exercise the pool. */
  gateDelayMs?: Record<string, number>;
  /** Critique envelope written for --check-critique invocations. */
  critique?: {
    outcome: "pass" | "fail" | "skipped";
    findings?: Array<{ severity: string; category: string; description: string }>;
    error?: string;
  };
  /** Whether signoff critique/snapshot envelopes report a persisted snapshot. */
  snapshotSaved?: boolean;
}

interface FakeExecRecord {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

function makeFakeExec(config: FakeExecConfig): {
  exec: QaRunExec;
  calls: FakeExecRecord[];
  maxInFlight: () => number;
} {
  const calls: FakeExecRecord[] = [];
  let inFlight = 0;
  let peak = 0;
  const exec: QaRunExec = async (argv: string[], options: QaRunExecOptions) => {
    calls.push({ argv, env: options.env });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      if (argv.includes("--qa-plan")) {
        // Planner runs with --json: the envelope arrives on stdout.
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            config.planManifest ? { qaPlan: { manifest: config.planManifest } } : {},
          ),
          stderr: "",
        };
      }
      const outPrefix = argvValue(argv, "--out");
      if (!outPrefix) return { exitCode: 1, stdout: "", stderr: "", error: "missing --out" };
      if (argv.includes("--check-critique")) {
        const critique = config.critique ?? { outcome: "pass" as const };
        const envelope: Record<string, unknown> = {
          critique: {
            rule: "critique",
            tiles: 3,
            provider: critique.outcome !== "skipped",
            findings: critique.findings ?? [],
            outcome: critique.outcome,
            ...(critique.error ? { error: critique.error } : {}),
          },
          ...(argv.includes("--qa-snapshot") && config.snapshotSaved !== false
            ? { qaPlan: { snapshotSaved: { path: `${outPrefix}.snapshot.json` } } }
            : {}),
        };
        writeFileSync(`${outPrefix}.json`, JSON.stringify(envelope));
        return { exitCode: critique.outcome === "pass" ? 0 : 2, stdout: "", stderr: "" };
      }
      if (argv.includes("--qa-snapshot")) {
        const envelope =
          config.snapshotSaved !== false
            ? { qaPlan: { snapshotSaved: { path: `${outPrefix}.snapshot.json` } } }
            : {};
        writeFileSync(`${outPrefix}.json`, JSON.stringify(envelope));
        return ok();
      }
      // Deterministic gate / interaction capture.
      const contextId = outPrefix.split("/").pop() ?? "";
      const delay = config.gateDelayMs?.[contextId];
      if (delay) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      const hardError = config.gateError?.[contextId];
      if (hardError) return { exitCode: null, stdout: "", stderr: "", error: hardError };
      const exitCode = config.gateExit?.[contextId] ?? 0;
      const gateEnvelope = config.gateEnvelope?.[contextId] ?? {};
      writeFileSync(
        `${outPrefix}.json`,
        JSON.stringify(
          exitCode === 2
            ? { overflow: { hasHorizontalOverflow: true, overflowPx: 42 }, ...gateEnvelope }
            : gateEnvelope,
        ),
      );
      return { exitCode, stdout: "", stderr: "" };
    } finally {
      inFlight -= 1;
    }
  };
  return { exec, calls, maxInFlight: () => peak };
}

describe("runQaMatrix", () => {
  test("the gate pool never exceeds policy.command_concurrency", async () => {
    const contexts = ["a", "b", "c", "d", "e"].map((viewport) => ({
      viewport,
      theme: "light" as const,
      state: "default" as const,
    }));
    const fake = makeFakeExec({
      planManifest: manifest({ contexts }),
      gateDelayMs: Object.fromEntries(contexts.map((c) => [`${c.viewport}-light-default`, 15])),
    });
    const result = await runQaMatrix({
      job: job({ policy: { command_concurrency: 2 } }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(result.verdict).toBe("passed");
    expect(fake.maxInFlight()).toBeLessThanOrEqual(2);
    // 1 plan + 5 gates, nothing else (visual "none", review mode).
    expect(fake.calls).toHaveLength(6);
  });

  test("planner deterministic checks always execute and a job can only add gates", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: {
          deterministic: ["console", "overflow", "truncation", "placeholder"],
          interaction: [],
          visual: "none",
        },
      }),
    });
    const result = await runQaMatrix({
      job: job({ checks: [{ id: "runts", args: ["--check-runts", "--check-runts-fail"] }] }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(result.verdict).toBe("passed");
    const gate = fake.calls.find((call) => call.argv.includes("--out"));
    expect(gate?.argv).toContain("--check-overflow-fail");
    expect(gate?.argv).toContain("--check-truncation-fail");
    expect(gate?.argv).toContain("--check-placeholder-fail");
    expect(gate?.argv).toContain("--check-runts-fail");
    expect(result.commands[1]?.check_id).toContain("manifest:console");
    expect(result.commands[1]?.check_id).toContain("runts");
  });

  test("planner console diagnostics fail the gate before critique", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: ["console"], interaction: [], visual: "full-page" },
      }),
      gateEnvelope: {
        "desktop-light-default": {
          consoleErrors: [{ type: "error", text: "uncaught fixture error" }],
          pageErrors: [],
          failedRequests: [],
        },
      },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(result.verdict).toBe("failed");
    expect(result.commands[1]?.failures).toContain("console: uncaught fixture error");
    expect(fake.calls.some((call) => call.argv.includes("--check-critique"))).toBe(false);
  });

  test("an unmapped planner deterministic check stops incomplete", async () => {
    const fake = makeFakeExec({
      planManifest: manifest({
        checks: { deterministic: ["future-check"], interaction: [], visual: "none" },
      }),
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(result.verdict).toBe("incomplete");
    expect(fake.calls).toHaveLength(1);
    expect(result.blockers[0]?.reason).toContain("future-check");
  });

  test("an incomplete planner manifest stops the run before any further work", async () => {
    const fake = makeFakeExec({
      planManifest: manifest({ contexts: [], incomplete: { reason: "classification unknown" } }),
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(fake.calls).toHaveLength(1);
    expect(result.verdict).toBe("incomplete");
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]?.stage).toBe("plan");
    expect(result.blockers[0]?.reason).toContain("classification unknown");
  });

  test("a missing manifest is a plan blocker and stops the run", async () => {
    const fake = makeFakeExec({ planManifest: null });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(fake.calls).toHaveLength(1);
    expect(result.verdict).toBe("incomplete");
    expect(result.qa_plan).toBeNull();
    expect(result.blockers[0]?.stage).toBe("plan");
  });

  test("a failed gate prevents any critique execution", async () => {
    const fake = makeFakeExec({
      planManifest: manifest({
        checks: { deterministic: ["overflow"], interaction: [], visual: "full-page" },
      }),
      gateExit: { "mobile-light-default": 2 },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(result.verdict).toBe("failed");
    expect(fake.calls.some((call) => call.argv.includes("--check-critique"))).toBe(false);
    const failedGate = result.commands.find((c) => c.context_id === "mobile-light-default");
    expect(failedGate?.outcome).toBe("failed");
    expect(failedGate?.failures.some((f) => f.includes("overflow"))).toBe(true);
  });

  test("a timed-out gate becomes a named blocker and the verdict incomplete", async () => {
    const fake = makeFakeExec({
      planManifest: manifest(),
      gateError: { "desktop-dark-default": "killed by SIGTERM (timeout 120000ms)" },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(result.verdict).toBe("incomplete");
    const blocker = result.blockers.find((b) => b.context_id === "desktop-dark-default");
    expect(blocker?.stage).toBe("gates");
    expect(blocker?.reason).toContain("SIGTERM");
    const outcome = result.commands.find((c) => c.context_id === "desktop-dark-default");
    expect(outcome?.outcome).toBe("unknown");
  });

  test("result contexts stay manifest-ordered regardless of completion order", async () => {
    // First manifest context finishes last; the result must not reorder.
    const fake = makeFakeExec({
      planManifest: manifest(),
      gateDelayMs: { "desktop-light-default": 40, "mobile-light-default": 10 },
    });
    const result = await runQaMatrix({
      job: job({
        contexts: [{ id: "hd-dark-default", viewport: "hd", theme: "dark", state: "default" }],
        policy: { command_concurrency: 4 },
      }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(result.contexts.map((c) => c.id)).toEqual([
      "desktop-light-default",
      "mobile-light-default",
      "desktop-dark-default",
      "hd-dark-default",
    ]);
    const gateOrder = result.commands.slice(1).map((c) => c.context_id);
    expect(gateOrder).toEqual([
      "desktop-light-default",
      "mobile-light-default",
      "desktop-dark-default",
      "hd-dark-default",
    ]);
  });

  test("dark contexts render through --color-scheme dark", async () => {
    const fake = makeFakeExec({ planManifest: manifest() });
    await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    const darkGate = fake.calls.find(
      (call) => call.argv.includes("desktop") && call.argv.includes("--color-scheme"),
    );
    expect(darkGate).toBeDefined();
    expect(argvValue(darkGate?.argv ?? [], "--color-scheme")).toBe("dark");
    const lightGate = fake.calls.find((call) => argvValue(call.argv, "--viewport") === "mobile");
    expect(lightGate?.argv.includes("--color-scheme")).toBe(false);
  });

  test("critique children carry the headless-only env var by default", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass" },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(result.verdict).toBe("passed");
    const critiqueCall = fake.calls.find((call) => call.argv.includes("--check-critique"));
    expect(critiqueCall?.env[QA_RUN_HEADLESS_ONLY_ENV]).toBe("1");
    // Gate children never carry it.
    const gateCall = fake.calls.find(
      (call) => argvValue(call.argv, "--out")?.endsWith("desktop-light-default") ?? false,
    );
    expect(gateCall?.env[QA_RUN_HEADLESS_ONLY_ENV]).toBeUndefined();
  });

  test("allow_metered_critique drops the headless-only env var", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass" },
    });
    await runQaMatrix({
      job: job({ policy: { allow_metered_critique: true } }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    const critiqueCall = fake.calls.find((call) => call.argv.includes("--check-critique"));
    expect(critiqueCall).toBeDefined();
    expect(critiqueCall?.env[QA_RUN_HEADLESS_ONLY_ENV]).toBeUndefined();
  });

  test("signoff critique argv carries --qa-snapshot with the context labels", async () => {
    const contexts = [{ viewport: "mobile", theme: "dark" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass" },
      snapshotSaved: true,
    });
    const result = await runQaMatrix({
      job: job({ mode: "signoff" }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    const critiqueCall = fake.calls.find((call) => call.argv.includes("--check-critique"));
    expect(critiqueCall?.argv.includes("--qa-snapshot")).toBe(true);
    expect(argvValue(critiqueCall?.argv ?? [], "--qa-theme")).toBe("dark");
    expect(argvValue(critiqueCall?.argv ?? [], "--qa-state")).toBe("default");
    expect(result.snapshot.saved).toBe(true);
    expect(result.verdict).toBe("passed");
  });

  test("review critique argv never carries --qa-snapshot", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass" },
    });
    await runQaMatrix({
      job: job({ mode: "review" }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    const critiqueCall = fake.calls.find((call) => call.argv.includes("--check-critique"));
    expect(critiqueCall?.argv.includes("--qa-snapshot")).toBe(false);
  });

  test("a skipped critique under the headless-only policy names the escape hatch", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "skipped", error: "no headless harness available" },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(result.verdict).toBe("incomplete");
    const blocker = result.blockers.find((b) => b.stage === "critique");
    expect(blocker?.reason).toContain(QA_RUN_HEADLESS_ONLY_ENV);
    expect(blocker?.reason).toContain("allow_metered_critique");
  });

  test("a manifest interaction state missing from the job is a blocker", async () => {
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts: [
          { viewport: "desktop", theme: "light", state: "default" },
          { viewport: "desktop", theme: "light", state: "menu-open" },
        ],
      }),
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    expect(result.verdict).toBe("incomplete");
    const blocker = result.blockers.find((b) => b.stage === "interactions");
    expect(blocker?.reason).toContain("menu-open");
  });

  test("interactions run serially with --assert and --assert-fail", async () => {
    const fake = makeFakeExec({ planManifest: manifest() });
    await runQaMatrix({
      job: job({
        interaction_states: [
          {
            name: "menu-open",
            setup: ["--click", "#menu"],
            assertions: ["exists .menu-panel", "count .item => >=3"],
          },
        ],
      }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    const interactionCall = fake.calls.find((call) =>
      (argvValue(call.argv, "--out") ?? "").endsWith("interaction-menu-open"),
    );
    expect(interactionCall).toBeDefined();
    const argv = interactionCall?.argv ?? [];
    expect(argv.filter((a) => a === "--assert")).toHaveLength(2);
    expect(argv.includes("--assert-fail")).toBe(true);
    expect(argvValue(argv, "--click")).toBe("#menu");
  });

  test("signoff with visual none runs a dedicated snapshot pass", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({ contexts }),
      snapshotSaved: true,
    });
    const result = await runQaMatrix({
      job: job({ mode: "signoff" }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
    });
    const snapshotCall = fake.calls.find((call) => call.argv.includes("--qa-snapshot"));
    expect(snapshotCall).toBeDefined();
    expect(result.snapshot.saved).toBe(true);
    expect(result.verdict).toBe("passed");
  });
});
