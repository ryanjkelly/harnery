import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { CritiqueProvider, CritiqueTile } from "./critique.ts";
import {
  PAGE_REVIEW_PACK_DIRNAME,
  readPackManifest,
  writePackContext,
} from "./page-review-pack.ts";
import type { QaManifest } from "./qa-plan.ts";
import {
  defaultQaRunExec,
  QA_RUN_HEADLESS_ONLY_ENV,
  QA_RUN_JOB_FILENAME,
  QA_RUN_KILL_GRACE_MS,
  QA_RUN_LATEST_FILENAME,
  QA_RUN_RESULT_FILENAME,
  QA_RUN_STATUS_FILENAME,
  type QaRunExec,
  type QaRunExecOptions,
  type QaRunExecResult,
  runQaMatrix,
} from "./qa-run.ts";
import {
  assessQaRunEvidence,
  computeJobDigest,
  QA_RUN_JOB_SCHEMA_VERSION,
  type QaRunJob,
} from "./qa-run-contracts.ts";
import { loadQaSnapshot } from "./qa-snapshot.ts";

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
  /** The in-process judge provider. `skipped` means no provider at all. */
  critique?: {
    outcome: "pass" | "fail" | "skipped";
    findings?: Array<{
      severity: "high" | "medium" | "low";
      category: string;
      description: string;
    }>;
    error?: string;
    /** Host provider_meta the fake provider reports after the pool ran. */
    provider_meta?: Record<string, unknown>;
    /** Coverage block the capture child records for every context. */
    coverage?: Record<string, unknown>;
    /** Async delay per tile call, to exercise the pool and the deadline. */
    delayMs?: number;
    /** Provider-declared concurrency (default 4). */
    concurrency?: number;
    /** Throw on every tile call with this message. */
    throws?: string;
  };
  /** Per-capture hard failure by context id (spawn error / timeout). */
  captureError?: Record<string, string>;
  /** Full-page bands the fake capture writes per context (default 3). */
  captureTiles?: number;
  /** Whether signoff snapshot envelopes (visual "none" path) report a persisted snapshot. */
  snapshotSaved?: boolean;
}

function blankPng(width: number, height: number): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

function fakeTiles(count: number, label: string): CritiqueTile[] {
  const png = blankPng(8, 8).toString("base64");
  return Array.from({ length: count }, (_, index) => ({
    index,
    label: `${label} ${index + 1}`,
    scrollY: index * 1280,
    x: 0,
    width: 8,
    height: 8,
    pngBase64: png,
  }));
}

interface ProviderCall {
  tile: string;
  url: string;
  headlessOnlyEnv: string | undefined;
}

interface FakeExecRecord {
  argv: string[];
  env: NodeJS.ProcessEnv;
}

function makeFakeExec(config: FakeExecConfig): {
  exec: QaRunExec;
  calls: FakeExecRecord[];
  maxInFlight: () => number;
  provider: CritiqueProvider | undefined;
  providerCalls: ProviderCall[];
  maxProviderInFlight: () => number;
  snapshotRoot: string;
} {
  const calls: FakeExecRecord[] = [];
  let inFlight = 0;
  let peak = 0;
  const snapshotRoot = mkdtempSync(join(tmpdir(), "qa-run-snapshots-"));

  // The judge runs in-process: the fake provider stands in for the host's
  // vision call and records what it saw.
  const critique = config.critique ?? { outcome: "pass" as const };
  const providerCalls: ProviderCall[] = [];
  let providerInFlight = 0;
  let providerPeak = 0;
  let provider: CritiqueProvider | undefined;
  if (critique.outcome !== "skipped") {
    const call: CritiqueProvider = async ({ url, tile }) => {
      providerInFlight += 1;
      providerPeak = Math.max(providerPeak, providerInFlight);
      try {
        providerCalls.push({
          tile: tile.label,
          url,
          headlessOnlyEnv: process.env[QA_RUN_HEADLESS_ONLY_ENV],
        });
        if (critique.delayMs) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, critique.delayMs));
        }
        if (critique.throws) throw new Error(critique.throws);
        const findings =
          critique.findings ??
          (critique.outcome === "fail"
            ? [{ severity: "high" as const, category: "text-clipping", description: "cut off" }]
            : []);
        // One finding set per context: attach to the first tile only.
        return tile.index === 0 ? findings.map((f) => ({ ...f, tile: tile.index })) : [];
      } finally {
        providerInFlight -= 1;
      }
    };
    call.concurrency = critique.concurrency ?? 4;
    call.meta = () => critique.provider_meta;
    provider = call;
  }
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
      if (argv.includes("--review-pack")) {
        const packDir = argvValue(argv, "--review-pack") ?? "";
        const contextId = argvValue(argv, "--review-pack-context") ?? "";
        const hardError = config.captureError?.[contextId];
        if (hardError) return { exitCode: null, stdout: "", stderr: "", error: hardError };
        const withBands = !argv.includes("--no-review-pack-bands");
        const scopes = argv.flatMap((arg, i) =>
          arg === "--review-pack-scope" ? [argv[i + 1] ?? ""] : [],
        );
        const bandCount = withBands ? (config.captureTiles ?? 3) : 0;
        const coverage = (critique.coverage as
          | {
              page_height_px: number;
              reviewed_height_px: number;
              bands_total: number;
              bands_reviewed: number;
              capped: boolean;
            }
          | undefined) ?? {
          page_height_px: Math.max(1, bandCount) * 1400,
          reviewed_height_px: Math.max(1, bandCount) * 1400,
          bands_total: bandCount,
          bands_reviewed: bandCount,
          capped: false,
        };
        const record = writePackContext(packDir, {
          context: {
            id: contextId,
            viewport: argvValue(argv, "--viewport") ?? "desktop",
            theme: argvValue(argv, "--qa-theme") === "dark" ? "dark" : "light",
            state: argvValue(argv, "--qa-state") ?? "default",
          },
          url: "http://localhost:4276/page",
          title: "fixture",
          fullPage: blankPng(64, 64),
          pageWidth: 64,
          pageHeight: 64,
          tiles: fakeTiles(bandCount, "band"),
          coverage,
          scopeTiles: scopes.map((selector) => ({ selector, tiles: fakeTiles(2, selector) })),
          signature: {
            url: "http://localhost:4276/page",
            capturedAt: new Date().toISOString(),
            nodes: [],
            stylesheets: [],
          },
          domHtml: "<html><body>fixture</body></html>",
        });
        writeFileSync(
          `${outPrefix}.json`,
          JSON.stringify({ reviewPack: { context_id: record.id, tiles: record.tiles.length } }),
        );
        return ok();
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
  return {
    exec,
    calls,
    maxInFlight: () => peak,
    provider,
    providerCalls,
    maxProviderInFlight: () => providerPeak,
    snapshotRoot,
  };
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("failed");
    expect(result.commands[1]?.failures).toContain("console: uncaught fixture error");
    expect(fake.calls.some((call) => call.argv.includes("--review-pack"))).toBe(false);
    expect(fake.providerCalls).toHaveLength(0);
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("failed");
    expect(fake.calls.some((call) => call.argv.includes("--review-pack"))).toBe(false);
    expect(fake.providerCalls).toHaveLength(0);
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    const darkGate = fake.calls.find(
      (call) => call.argv.includes("desktop") && call.argv.includes("--color-scheme"),
    );
    expect(darkGate).toBeDefined();
    expect(argvValue(darkGate?.argv ?? [], "--color-scheme")).toBe("dark");
    const lightGate = fake.calls.find((call) => argvValue(call.argv, "--viewport") === "mobile");
    expect(lightGate?.argv.includes("--color-scheme")).toBe(false);
  });

  test("the critique pool carries per-backend vision latency from provider_meta", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: {
        outcome: "pass",
        provider_meta: {
          route: ["claude-code", "codex"],
          providers: {
            "claude-code": {
              family: "headless",
              attempts: 3,
              latency_ms: { count: 3, p50: 4_200, p95: 9_100 },
            },
            // Never called: percentiles over an empty sample carry nothing.
            codex: { family: "headless", attempts: 0, latency_ms: { count: 0, p50: 0, p95: 0 } },
            // Malformed entry from a future host build must not throw or leak.
            broken: { latency_ms: "fast" },
          },
        },
      },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.critique).toHaveLength(1);
    expect(result.critique_pool?.latency_ms).toEqual({
      "claude-code": { count: 3, p50: 4_200, p95: 9_100 },
    });
    expect(result.critique_pool?.tiles_total).toBe(3);
    expect(result.critique_pool?.tiles_reviewed).toBe(3);
  });

  test("the critique pool omits latency_ms when the provider reported none", async () => {
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.critique).toHaveLength(1);
    expect(result.critique_pool).toBeDefined();
    expect("latency_ms" in (result.critique_pool ?? {})).toBe(false);
  });

  test("a scoped manifest captures every scope in one browser session and judges only scope tiles", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        scopes: [
          { selector: "#hero", reason: "test", matches: 1 },
          { selector: "#footer", reason: "test", matches: 1 },
        ],
        checks: { deterministic: [], interaction: [], visual: "scoped" },
      }),
      critique: {
        outcome: "fail",
        findings: [{ severity: "high", category: "overlap", description: "hero text collides" }],
      },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    const captures = fake.calls.filter((call) => call.argv.includes("--review-pack"));
    expect(captures).toHaveLength(1);
    const argv = captures[0]?.argv ?? [];
    expect(argv.filter((arg) => arg === "--review-pack-scope")).toHaveLength(2);
    expect(argv.includes("--no-review-pack-bands")).toBe(true);
    // Two scopes × two tiles, no bands.
    expect(result.critique[0]?.tiles_total).toBe(4);
    expect(fake.providerCalls).toHaveLength(4);
    // Findings name the pack tile and the scope it was cut for.
    expect(result.critique[0]?.outcome).toBe("failed");
    const finding = result.critique[0]?.findings[0];
    expect(finding?.tile).toBe("desktop-light-default/T001");
    expect(finding?.selector).toBe("#hero");
    expect(result.verdict).toBe("failed");
  });

  const CAPPED_COVERAGE = {
    page_height_px: 67_364,
    reviewed_height_px: 30_840,
    bands_total: 53,
    bands_reviewed: 24,
    capped: true,
  };

  test("signoff refuses a capped critique: blocker, unknown row, incomplete verdict", async () => {
    const contexts = [{ viewport: "mobile", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass", coverage: CAPPED_COVERAGE },
      snapshotSaved: true,
    });
    const result = await runQaMatrix({
      job: job({ mode: "signoff" }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.critique[0]?.coverage).toEqual(CAPPED_COVERAGE);
    expect(result.critique[0]?.outcome).toBe("unknown");
    const blocker = result.blockers.find((b) => b.reason.includes("critique coverage capped"));
    expect(blocker?.stage).toBe("critique");
    expect(blocker?.context_id).toBe("mobile-light-default");
    expect(blocker?.reason).toContain("24 of 53 bands");
    expect(blocker?.reason).toContain("policy.critique_max_tiles");
    expect(result.verdict).toBe("incomplete");
  });

  test("review mode keeps a capped critique's pass but flags the row", async () => {
    const contexts = [{ viewport: "mobile", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass", coverage: CAPPED_COVERAGE },
    });
    const result = await runQaMatrix({
      job: job({ mode: "review" }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.critique[0]?.coverage?.capped).toBe(true);
    expect(result.critique[0]?.outcome).toBe("passed");
    expect(result.blockers).toHaveLength(0);
    expect(result.verdict).toBe("passed");
  });

  test("an uncapped critique row carries coverage and no blocker in signoff", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: {
        outcome: "pass",
        coverage: {
          ...CAPPED_COVERAGE,
          reviewed_height_px: 67_364,
          bands_reviewed: 53,
          capped: false,
        },
      },
      snapshotSaved: true,
    });
    const result = await runQaMatrix({
      job: job({ mode: "signoff" }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.critique[0]?.coverage?.capped).toBe(false);
    expect(result.verdict).toBe("passed");
  });

  test("policy.critique_max_tiles reaches the planner and every capture child", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass" },
    });
    await runQaMatrix({
      job: job({ policy: { critique_max_tiles: 60 } }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    const planCall = fake.calls.find((call) => call.argv.includes("--qa-plan"));
    expect(argvValue(planCall?.argv ?? [], "--check-critique-max-tiles")).toBe("60");
    const captureCalls = fake.calls.filter((call) => call.argv.includes("--review-pack"));
    expect(captureCalls.length).toBeGreaterThan(0);
    for (const call of captureCalls) {
      expect(argvValue(call.argv, "--check-critique-max-tiles")).toBe("60");
    }
    const gateCall = fake.calls.find(
      (call) => !call.argv.includes("--qa-plan") && !call.argv.includes("--review-pack"),
    );
    expect(gateCall?.argv.includes("--check-critique-max-tiles")).toBe(false);
  });

  test("the judge runs under the headless-only env var by default; children never see it", async () => {
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("passed");
    expect(fake.providerCalls.length).toBeGreaterThan(0);
    for (const call of fake.providerCalls) expect(call.headlessOnlyEnv).toBe("1");
    // Restored once the judge is done.
    expect(process.env[QA_RUN_HEADLESS_ONLY_ENV]).toBeUndefined();
    // Gate and capture children never carry it.
    for (const call of fake.calls) expect(call.env[QA_RUN_HEADLESS_ONLY_ENV]).toBeUndefined();
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(fake.providerCalls.length).toBeGreaterThan(0);
    for (const call of fake.providerCalls) expect(call.headlessOnlyEnv).toBeUndefined();
  });

  test("signoff persists each context's snapshot from the pack, critique attached", async () => {
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    // No child carries --qa-snapshot any more: the runner persists from the pack.
    expect(fake.calls.some((call) => call.argv.includes("--qa-snapshot"))).toBe(false);
    const captureCall = fake.calls.find((call) => call.argv.includes("--review-pack"));
    expect(argvValue(captureCall?.argv ?? [], "--qa-theme")).toBe("dark");
    expect(argvValue(captureCall?.argv ?? [], "--qa-state")).toBe("default");
    expect(result.snapshot.saved).toBe(true);
    expect(result.verdict).toBe("passed");
    const stored = loadQaSnapshot(
      job().target,
      { viewport: "mobile", theme: "dark", state: "default" },
      { root: fake.snapshotRoot },
    );
    expect(stored?.screenshotPath).toBeDefined();
    expect(stored?.critique?.outcome).toBe("pass");
    expect(stored?.critique?.tiles).toHaveLength(3);
  });

  test("review mode never persists a snapshot", async () => {
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(fake.calls.some((call) => call.argv.includes("--qa-snapshot"))).toBe(false);
    const stored = loadQaSnapshot(
      job().target,
      { viewport: "desktop", theme: "light", state: "default" },
      { root: fake.snapshotRoot },
    );
    expect(stored).toBeNull();
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
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

  test("a visual run writes a page review pack and names it in the result", async () => {
    const contexts = [
      { viewport: "desktop", theme: "light" as const, state: "default" },
      { viewport: "mobile", theme: "dark" as const, state: "default" },
    ];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: {
        outcome: "fail",
        findings: [{ severity: "high", category: "text-clipping", description: "cut off" }],
      },
    });
    const parent = outDir();
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
      runId: "packed",
      reviewPackJudgeCommand: (dir) => `harn review-pack judge ${dir}`,
    });
    const packDir = join(parent, "run-packed", PAGE_REVIEW_PACK_DIRNAME);
    expect(result.review_pack?.dir).toBe(packDir);
    expect(existsSync(join(packDir, "review.md"))).toBe(true);
    expect(existsSync(join(packDir, "findings.json"))).toBe(true);
    expect(existsSync(join(packDir, "contexts", "mobile-dark-default", "tiles", "T001.png"))).toBe(
      true,
    );
    const pack = readPackManifest(packDir);
    expect(pack.contexts.map((ctx) => ctx.id)).toEqual([
      "desktop-light-default",
      "mobile-dark-default",
    ]);
    expect(pack.critique).toHaveLength(2);
    expect(pack.critique?.[0]?.findings[0]?.tile_id).toBe("T001");
    const review = readFileSync(join(packDir, "review.md"), "utf8");
    expect(review).toContain("## Machine findings");
    expect(review).toContain("text-clipping: cut off");
    // The capture stage is a child per context; the judge is one pool.
    expect(result.commands.filter((c) => c.check_id === "review-pack")).toHaveLength(2);
    expect(result.critique_pool?.tiles_total).toBe(6);
    expect(result.critique[0]?.findings[0]?.tile).toBe("desktop-light-default/T001");
    expect(result.verdict).toBe("failed");
    expect(result.wall_time_ms.capture).toBeGreaterThanOrEqual(0);
  });

  test("policy.critique_pool bounds vision calls across every context", async () => {
    const contexts = [
      { viewport: "desktop", theme: "light" as const, state: "default" },
      { viewport: "mobile", theme: "light" as const, state: "default" },
      { viewport: "desktop", theme: "dark" as const, state: "default" },
    ];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass", delayMs: 10, concurrency: 1 },
      captureTiles: 4,
    });
    const result = await runQaMatrix({
      job: job({ policy: { critique_pool: 6 } }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("passed");
    expect(fake.providerCalls).toHaveLength(12);
    // The pool crosses context boundaries: more in flight than one context's
    // tiles would allow under a per-context provider.
    expect(fake.maxProviderInFlight()).toBeGreaterThan(4);
    expect(fake.maxProviderInFlight()).toBeLessThanOrEqual(6);
    expect(result.critique_pool?.concurrency).toBe(6);
  });

  test("a capture child that dies is a capture blocker; the other contexts are still judged", async () => {
    const contexts = [
      { viewport: "desktop", theme: "light" as const, state: "default" },
      { viewport: "mobile", theme: "light" as const, state: "default" },
    ];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      captureError: { "mobile-light-default": "killed by SIGTERM (timeout 120000ms)" },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("incomplete");
    const blocker = result.blockers.find((b) => b.stage === "capture");
    expect(blocker?.context_id).toBe("mobile-light-default");
    expect(blocker?.reason).toContain("SIGTERM");
    expect(result.critique.map((row) => row.context_id)).toEqual(["desktop-light-default"]);
    expect(result.critique[0]?.outcome).toBe("passed");
    expect(result.last_completed_stage).toBe("interactions");
  });

  test("a provider throw on one tile is a high provider-error finding, never a crash", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: [], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass", throws: "harness exited 1" },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("failed");
    expect(result.critique[0]?.findings.every((f) => f.summary.startsWith("provider-error"))).toBe(
      true,
    );
  });

  test("a scoped signoff persists the snapshot without a critique record", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        scopes: [{ selector: "#hero", reason: "test", matches: 1 }],
        checks: { deterministic: [], interaction: [], visual: "scoped" },
      }),
      critique: { outcome: "pass" },
    });
    const result = await runQaMatrix({
      job: job({ mode: "signoff" }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("passed");
    const stored = loadQaSnapshot(
      job().target,
      { viewport: "desktop", theme: "light", state: "default" },
      { root: fake.snapshotRoot },
    );
    expect(stored?.screenshotPath).toBeDefined();
    expect(stored?.critique).toBeUndefined();
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    const snapshotCall = fake.calls.find((call) => call.argv.includes("--qa-snapshot"));
    expect(snapshotCall).toBeDefined();
    expect(result.snapshot.saved).toBe(true);
    expect(result.verdict).toBe("passed");
  });
});

describe("runQaMatrix run identity", () => {
  test("runId places artifacts and the result under run-<id> and latest.json points at it", async () => {
    const parent = outDir();
    const fake = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
      runId: "fixed",
    });
    const runDir = join(parent, "run-fixed");
    expect(result.run.run_id).toBe("fixed");
    expect(result.run.out_dir.endsWith("run-fixed")).toBe(true);
    expect(existsSync(join(runDir, QA_RUN_RESULT_FILENAME))).toBe(true);
    // Gate artifacts land inside the run dir, not the parent.
    expect(existsSync(join(runDir, "desktop-light-default.json"))).toBe(true);
    expect(existsSync(join(parent, "desktop-light-default.json"))).toBe(false);
    const latest = JSON.parse(readFileSync(join(parent, QA_RUN_LATEST_FILENAME), "utf8")) as Record<
      string,
      unknown
    >;
    expect(latest.run_id).toBe("fixed");
    expect(latest.dir).toBe("run-fixed");
    expect(latest.result).toBe(join("run-fixed", QA_RUN_RESULT_FILENAME));
    expect(latest.verdict).toBe(result.verdict);
    expect(latest.completed_at).toBe(result.run.completed_at);
  });

  test("two sequential runs keep both run dirs and latest.json points at the second", async () => {
    const parent = outDir();
    const first = makeFakeExec({ planManifest: manifest() });
    await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec: first.exec,
      runId: "first",
    });
    const second = makeFakeExec({ planManifest: manifest() });
    await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec: second.exec,
      runId: "second",
    });
    expect(existsSync(join(parent, "run-first", QA_RUN_RESULT_FILENAME))).toBe(true);
    expect(existsSync(join(parent, "run-second", QA_RUN_RESULT_FILENAME))).toBe(true);
    const latest = JSON.parse(readFileSync(join(parent, QA_RUN_LATEST_FILENAME), "utf8")) as Record<
      string,
      unknown
    >;
    expect(latest.run_id).toBe("second");
    expect(latest.dir).toBe("run-second");
  });

  test("the run block carries ISO bounds and the digest of the executed job", async () => {
    const theJob = job();
    const fake = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: theJob,
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
      runId: "identity",
    });
    for (const stamp of [result.run.started_at, result.run.completed_at]) {
      expect(new Date(stamp).toISOString()).toBe(stamp);
    }
    expect(Date.parse(result.run.completed_at)).toBeGreaterThanOrEqual(
      Date.parse(result.run.started_at),
    );
    expect(result.run.job_digest).toBe(computeJobDigest(theJob));
  });

  test('revision_source is "job" when the job pins tested_revision, ignoring the probe', async () => {
    const fake = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job({ tested_revision: "abc123" }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
      revisionProbe: { tested_revision: "zzz999", worktree_dirty: true },
    });
    expect(result.run.revision_source).toBe("job");
    expect(result.run.tested_revision).toBe("abc123");
    expect(result.run.worktree_dirty).toBeUndefined();
    expect(result.tested_revision).toBe("abc123");
  });

  test('revision_source is "git" with worktree_dirty carried when only a probe is supplied', async () => {
    const fake = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
      revisionProbe: { tested_revision: "def456", worktree_dirty: true },
    });
    expect(result.run.revision_source).toBe("git");
    expect(result.run.tested_revision).toBe("def456");
    expect(result.run.worktree_dirty).toBe(true);
    expect(result.tested_revision).toBe("def456");
  });

  test('revision_source is "unknown" when neither the job nor a probe names a revision', async () => {
    const fake = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.run.revision_source).toBe("unknown");
    expect(result.run.tested_revision).toBeUndefined();
    expect(result.run.worktree_dirty).toBeUndefined();
  });

  test("host samples carry numeric pressure fields at start and finish", async () => {
    const fake = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    for (const sample of [result.host.start, result.host.finish]) {
      expect(new Date(sample.captured_at).toISOString()).toBe(sample.captured_at);
      expect(Number.isFinite(sample.loadavg_1m)).toBe(true);
      expect(Number.isFinite(sample.free_mem_bytes)).toBe(true);
      expect(Number.isFinite(sample.total_mem_bytes)).toBe(true);
      expect(sample.total_mem_bytes).toBeGreaterThan(0);
      expect(Number.isInteger(sample.cpu_count)).toBe(true);
      expect(sample.cpu_count).toBeGreaterThanOrEqual(1);
    }
  });

  test("the written result assesses fresh in place and stale after being copied elsewhere", async () => {
    const parent = outDir();
    const theJob = job();
    const fake = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: theJob,
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
      runId: "evidence",
    });
    const runDir = join(parent, "run-evidence");
    const expectations = {
      run_id: "evidence",
      job_digest: computeJobDigest(theJob),
      found_in_dir: runDir,
    };
    const parsed: unknown = JSON.parse(readFileSync(join(runDir, QA_RUN_RESULT_FILENAME), "utf8"));
    const inPlace = assessQaRunEvidence(parsed, expectations);
    expect(inPlace.fresh).toBe(true);
    expect(inPlace.reasons).toEqual([]);
    expect(inPlace.verdict).toBe(result.verdict);
    // The moved-result rule: the same document read from another directory is
    // not evidence for that directory.
    const elsewhere = outDir();
    copyFileSync(join(runDir, QA_RUN_RESULT_FILENAME), join(elsewhere, QA_RUN_RESULT_FILENAME));
    const movedDocument: unknown = JSON.parse(
      readFileSync(join(elsewhere, QA_RUN_RESULT_FILENAME), "utf8"),
    );
    const moved = assessQaRunEvidence(movedDocument, { ...expectations, found_in_dir: elsewhere });
    expect(moved.fresh).toBe(false);
    expect(moved.reasons).toHaveLength(1);
    expect(moved.reasons[0]).toContain("moved or copied");
  });
});

describe("runQaMatrix last_completed_stage", () => {
  test("null when the planner fails", async () => {
    const fake = makeFakeExec({ planManifest: null });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.last_completed_stage).toBeNull();
  });

  test('a clean review with visual "none" ends at interactions', async () => {
    const fake = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("passed");
    expect(result.last_completed_stage).toBe("interactions");
  });

  test("a gate blocker ends the clean prefix at plan", async () => {
    const fake = makeFakeExec({
      planManifest: manifest(),
      gateError: { "desktop-dark-default": "killed by SIGTERM (timeout 120000ms)" },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.blockers.some((b) => b.stage === "gates")).toBe(true);
    // Prefix semantics: the (empty) interactions stage executes after the
    // blocked gates stage, but the run stopped progressing cleanly at plan.
    expect(result.last_completed_stage).toBe("plan");
    // The invariant: last_completed_stage is never a stage a blocker names.
    expect(result.blockers.some((b) => b.stage === result.last_completed_stage)).toBe(false);
  });

  test("gates is last when only the interactions stage is blocked", async () => {
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.blockers.some((b) => b.stage === "interactions")).toBe(true);
    expect(result.last_completed_stage).toBe("gates");
  });

  test("plan is last when both gates and interactions are blocked", async () => {
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts: [
          { viewport: "desktop", theme: "light", state: "default" },
          { viewport: "desktop", theme: "light", state: "menu-open" },
        ],
      }),
      gateError: { "desktop-light-default": "killed by SIGTERM (timeout 120000ms)" },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.blockers.some((b) => b.stage === "gates")).toBe(true);
    expect(result.blockers.some((b) => b.stage === "interactions")).toBe(true);
    expect(result.last_completed_stage).toBe("plan");
  });

  test("a clean review with a visual pass ends at critique", async () => {
    const contexts = [{ viewport: "desktop", theme: "light" as const, state: "default" }];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: ["overflow"], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass" },
    });
    const result = await runQaMatrix({
      job: job(),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("passed");
    expect(result.last_completed_stage).toBe("critique");
  });

  test('a passing signoff with visual "none" ends at snapshot', async () => {
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
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("passed");
    expect(result.last_completed_stage).toBe("snapshot");
  });
});

describe("runQaMatrix admission and status artifacts", () => {
  test("writes job.json and a completed run-status.json in the run directory", async () => {
    const parent = outDir();
    const { exec } = makeFakeExec({ planManifest: manifest() });
    const theJob = job();
    const result = await runQaMatrix({
      job: theJob,
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "status-artifacts",
    });
    const runDir = join(parent, "run-status-artifacts");
    const writtenJob = JSON.parse(readFileSync(join(runDir, QA_RUN_JOB_FILENAME), "utf8"));
    expect(computeJobDigest(writtenJob as QaRunJob)).toBe(result.run.job_digest);
    const status = JSON.parse(readFileSync(join(runDir, QA_RUN_STATUS_FILENAME), "utf8"));
    expect(status.state).toBe("completed");
    expect(status.run_id).toBe("status-artifacts");
    expect(status.pid).toBe(process.pid);
    expect(status.stage).toBeNull();
    expect(status.verdict).toBe(result.verdict);
  });

  test("acquired admission records queue wait, keeps total pure, and releases once", async () => {
    const parent = outDir();
    const { exec } = makeFakeExec({ planManifest: manifest() });
    let released = 0;
    let statusWhileQueued: Record<string, unknown> | undefined;
    const runDir = join(parent, "run-queued-run");
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "queued-run",
      admission: {
        resource: "browser-qa",
        acquire: async () => {
          statusWhileQueued = JSON.parse(
            readFileSync(join(runDir, QA_RUN_STATUS_FILENAME), "utf8"),
          ) as Record<string, unknown>;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
          return () => {
            released += 1;
          };
        },
      },
    });
    expect(result.wall_time_ms.queue).toBeGreaterThanOrEqual(20);
    expect(result.wall_time_ms.total).toBeGreaterThanOrEqual(0);
    expect(released).toBe(1);
    expect(statusWhileQueued?.state).toBe("queued");
    expect((statusWhileQueued?.queue as Record<string, unknown>)?.resource).toBe("browser-qa");
    expect(result.verdict).toBe("passed");
  });

  test("admission failure finalizes incomplete with an admission blocker and no browser work", async () => {
    const parent = outDir();
    const { exec, calls } = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "queue-timeout",
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
    expect(result.commands).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(result.last_completed_stage).toBeNull();
    expect(typeof result.wall_time_ms.queue).toBe("number");
    const status = JSON.parse(
      readFileSync(join(parent, "run-queue-timeout", QA_RUN_STATUS_FILENAME), "utf8"),
    );
    expect(status.state).toBe("completed");
    expect(status.verdict).toBe("incomplete");
  });

  test("a run without admission records no queue clock", async () => {
    const parent = outDir();
    const { exec } = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
    });
    expect(result.wall_time_ms.queue).toBeUndefined();
  });
});

describe("runQaMatrix schema v4 diagnostics", () => {
  test("a runner result declares evidence_source runner", async () => {
    const parent = outDir();
    const { exec } = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
    });
    expect(result.evidence_source).toBe("runner");
    expect(result.schema_version).toBe(4);
  });

  test("each executed stage records the host pressure it started under", async () => {
    const parent = outDir();
    const { exec } = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job({ mode: "signoff" }),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
    });
    const stages = result.host.stages ?? {};
    for (const stage of [
      "plan",
      "gates",
      "interactions",
      "capture",
      "critique",
      "snapshot",
    ] as const) {
      expect(stages[stage]?.captured_at).toBeString();
      expect(stages[stage]?.cpu_count).toBeGreaterThan(0);
    }
  });

  test("host samples name the competing admission holders, excluding this run", async () => {
    const parent = outDir();
    const { exec } = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      admission: {
        resource: "browser-qa",
        acquire: async () => () => {},
        holders: () => [
          { label: "peer build", pid: 424242 },
          { label: "this run", pid: process.pid },
        ],
      },
    });
    expect(result.host.start.competing).toEqual([{ label: "peer build", pid: 424242 }]);
    expect(result.host.finish.competing).toEqual([{ label: "peer build", pid: 424242 }]);
  });

  test("a run without admission records no competing list", async () => {
    const parent = outDir();
    const { exec } = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
    });
    expect(result.host.start.competing).toBeUndefined();
  });
});

describe("latest.json pointer is monotonic", () => {
  test("a run finishing after a newer run does not move the pointer backwards", async () => {
    const parent = outDir();
    const { exec } = makeFakeExec({ planManifest: manifest() });
    // A concurrent run that completed later already published its pointer.
    const newerPointer = {
      schema_version: 1,
      run_id: "newer-run",
      dir: "run-newer-run",
      result: join("run-newer-run", QA_RUN_RESULT_FILENAME),
      completed_at: new Date(Date.now() + 60_000).toISOString(),
      verdict: "passed",
    };
    writeFileSync(
      join(parent, QA_RUN_LATEST_FILENAME),
      `${JSON.stringify(newerPointer, null, 2)}\n`,
    );
    const result = await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "older-run",
    });
    expect(result.verdict).toBe("passed");
    const pointer = JSON.parse(readFileSync(join(parent, QA_RUN_LATEST_FILENAME), "utf8"));
    expect(pointer.run_id).toBe("newer-run");
    // The run's own directory is still authoritative and complete.
    expect(existsSync(join(parent, "run-older-run", QA_RUN_RESULT_FILENAME))).toBe(true);
  });

  test("an unreadable pointer is replaced rather than trusted", async () => {
    const parent = outDir();
    const { exec } = makeFakeExec({ planManifest: manifest() });
    writeFileSync(join(parent, QA_RUN_LATEST_FILENAME), "{ not json");
    await runQaMatrix({
      job: job(),
      outParent: parent,
      browseArgv: BROWSE_ARGV,
      exec,
      runId: "recovering-run",
    });
    const pointer = JSON.parse(readFileSync(join(parent, QA_RUN_LATEST_FILENAME), "utf8"));
    expect(pointer.run_id).toBe("recovering-run");
  });
});

describe("defaultQaRunExec timeout enforcement", () => {
  // The live failure this guards against: a child that catches SIGTERM while
  // awaiting its own grandchildren turned execFile's timeout into an
  // unbounded wait (a critique command outlived its 120s cap by 10x).
  test("a SIGTERM-catching child is killed within timeout plus grace", async () => {
    const started = Date.now();
    const res = await defaultQaRunExec(["bash", "-c", "trap '' TERM; sleep 60"], {
      timeoutMs: 1_000,
      env: process.env,
    });
    const elapsed = Date.now() - started;
    expect(res.exitCode).toBeNull();
    expect(res.error).toContain("timed out after 1000ms");
    // SIGTERM at 1s is trapped; SIGKILL lands at 1s + grace. Generous slack
    // for a loaded CI host, but far below the 60s the child wanted.
    expect(elapsed).toBeLessThan(1_000 + QA_RUN_KILL_GRACE_MS + 10_000);
  }, 30_000);

  test("a grandchild in the child's process group dies with the group", async () => {
    const pidFile = join(outDir(), "grandchild.pid");
    const res = await defaultQaRunExec(
      ["bash", "-c", `trap '' TERM; (trap '' TERM; echo $BASHPID > ${pidFile}; sleep 60) & wait`],
      { timeoutMs: 1_000, env: process.env },
    );
    expect(res.error).toContain("timed out");
    const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);
    // The group SIGKILL is delivered before the exec promise settles; give
    // the kernel a beat to reap, then prove the grandchild is gone.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    let alive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 30_000);

  test("a child that exits 0 after the deadline still reports a timeout error", async () => {
    const res = await defaultQaRunExec(["bash", "-c", "trap 'exit 0' TERM; sleep 60"], {
      timeoutMs: 500,
      env: process.env,
    });
    expect(res.exitCode).toBeNull();
    expect(res.error).toContain("timed out");
  }, 30_000);

  test("a fast clean child is untouched", async () => {
    const res = await defaultQaRunExec(["bash", "-c", "echo hi"], {
      timeoutMs: 5_000,
      env: process.env,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
    expect(res.error).toBeUndefined();
  });
});

describe("runQaMatrix run deadline", () => {
  test("deadline during gates skips remaining commands and finalizes incomplete", async () => {
    const contexts = ["a", "b", "c", "d", "e"].map((viewport) => ({
      viewport,
      theme: "light" as const,
      state: "default" as const,
    }));
    const fake = makeFakeExec({
      planManifest: manifest({ contexts }),
      gateDelayMs: Object.fromEntries(contexts.map((c) => [`${c.viewport}-light-default`, 120])),
    });
    const result = await runQaMatrix({
      job: job({ policy: { command_concurrency: 1, run_deadline_ms: 100 } }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("incomplete");
    const blocker = result.blockers.find((entry) => entry.stage === "deadline");
    expect(blocker?.reason).toContain("run deadline of 100ms exceeded");
    // Serial gates at 120ms each against a 100ms deadline: the first gate
    // runs, every later context is skipped without a command row.
    const gates = result.commands.filter((command) => command.check_id !== "plan");
    expect(gates.length).toBeLessThan(contexts.length);
  });

  test("deadline during the judge leaves tiles unjudged and never reports a partial pass", async () => {
    const contexts = [
      { viewport: "desktop", theme: "light" as const, state: "default" },
      { viewport: "mobile", theme: "light" as const, state: "default" },
      { viewport: "desktop", theme: "dark" as const, state: "default" },
    ];
    const fake = makeFakeExec({
      planManifest: manifest({
        contexts,
        checks: { deterministic: ["overflow"], interaction: [], visual: "full-page" },
      }),
      critique: { outcome: "pass", delayMs: 120, concurrency: 2 },
    });
    const result = await runQaMatrix({
      job: job({ policy: { run_deadline_ms: 150 } }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("incomplete");
    // Every captured context has a row; the ones the pool never finished are
    // unknown with a critique blocker naming the deadline.
    expect(result.critique).toHaveLength(contexts.length);
    const cutOff = result.blockers.filter(
      (entry) => entry.stage === "critique" && entry.reason.includes("run deadline"),
    );
    expect(cutOff.length).toBeGreaterThan(0);
    for (const row of result.critique) {
      expect(["passed", "failed", "unknown"]).toContain(row.outcome);
      const blocked = cutOff.some((b) => b.context_id === row.context_id);
      if (blocked) expect(row.outcome).toBe("unknown");
    }
    expect(fake.providerCalls.length).toBeLessThan(9);
  });

  test("a run under its deadline is unaffected", async () => {
    const fake = makeFakeExec({ planManifest: manifest() });
    const result = await runQaMatrix({
      job: job({ policy: { run_deadline_ms: 60_000 } }),
      outParent: outDir(),
      browseArgv: BROWSE_ARGV,
      exec: fake.exec,
      critiqueProvider: fake.provider,
      snapshotStore: { root: fake.snapshotRoot },
    });
    expect(result.verdict).toBe("passed");
    expect(result.blockers).toHaveLength(0);
  });
});
