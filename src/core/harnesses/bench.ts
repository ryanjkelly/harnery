import { spawnSync } from "node:child_process";
import { HARNESS_SPECS } from "../hooks/harness/events.ts";
import type { SpawnRequest, SpawnResult } from "../workflow/types.ts";
import type { HarnessRegistry } from "./registry.ts";
import type {
  CapabilitySupport,
  HarnessAdapter,
  HarnessCapabilityDimension,
  HarnessId,
} from "./types.ts";
import { HARNESS_CAPABILITY_DIMENSIONS } from "./types.ts";

export type BenchVerdict =
  | "supported"
  | "partial"
  | "unsupported"
  | "not_applicable"
  | "unknown"
  | "skipped"
  | "drift";

export type BenchDimension = "registration" | "binary" | HarnessCapabilityDimension;

export interface BenchResult {
  harness: HarnessId;
  dimension: BenchDimension;
  declared: CapabilitySupport | "not_applicable";
  observed: BenchVerdict;
  verdict: BenchVerdict;
  note?: string;
}

export interface HarnessBenchReport {
  generatedAt: string;
  mode: "offline";
  harnesses: HarnessId[];
  results: BenchResult[];
  summary: Record<BenchVerdict, number>;
  drift: boolean;
  skipped: boolean;
}

export interface HarnessBenchOptions {
  harnesses?: readonly string[];
  dimensions?: readonly HarnessCapabilityDimension[];
  /** Test seam and alternate host probe. A null version means unavailable. */
  versionProbe?: (binary: string) => string | null;
}

const EMPTY_SUMMARY: Record<BenchVerdict, number> = {
  supported: 0,
  partial: 0,
  unsupported: 0,
  not_applicable: 0,
  unknown: 0,
  skipped: 0,
  drift: 0,
};

export function runHarnessBench(
  registry: HarnessRegistry,
  opts: HarnessBenchOptions = {},
): HarnessBenchReport {
  const ids = opts.harnesses?.length ? [...opts.harnesses] : registry.ids();
  const dimensions = opts.dimensions?.length
    ? [...new Set(opts.dimensions)]
    : [...HARNESS_CAPABILITY_DIMENSIONS];
  const versionProbe = opts.versionProbe ?? probeVersion;
  const results: BenchResult[] = [];

  for (const id of ids) {
    const adapter = registry.require(id);
    results.push({
      harness: id,
      dimension: "registration",
      declared: "supported",
      observed: "supported",
      verdict: "supported",
      note: `${adapter.profile.integrationMode}; ${adapter.profile.authModel}`,
    });

    const version = versionProbe(adapter.profile.binary);
    results.push({
      harness: id,
      dimension: "binary",
      declared: "supported",
      observed: version ? "supported" : "skipped",
      verdict: version ? "supported" : "skipped",
      note: version ?? `${adapter.profile.binary} not found on PATH`,
    });

    const observations = observeAdapter(adapter);
    for (const dimension of dimensions) {
      const claim = adapter.profile.capabilities[dimension];
      const observed = observations[dimension];
      results.push({
        harness: id,
        dimension,
        declared: claim.support,
        observed,
        verdict: reconcile(claim.support, observed),
        note: claim.note,
      });
    }
  }

  const summary = { ...EMPTY_SUMMARY };
  for (const result of results) summary[result.verdict]++;
  return {
    generatedAt: new Date().toISOString(),
    mode: "offline",
    harnesses: ids,
    results,
    summary,
    drift: summary.drift > 0,
    skipped: summary.skipped > 0,
  };
}

function observeAdapter(adapter: HarnessAdapter): Record<HarnessCapabilityDimension, BenchVerdict> {
  const profile = adapter.profile;
  const effort = profile.effortValues[0];
  const request: SpawnRequest = {
    prompt: "HARNERY_BENCH_PROMPT",
    model: "harnery-bench-model",
    effort,
    timeoutMs: 1_000,
    maxTurns: 7,
    cwd: "/harnery-bench",
  };
  let argv: string[] = [];
  let planningFailed = false;
  try {
    argv = adapter.buildInvocation(request, "/harnery-bench/final.txt").argv;
  } catch {
    planningFailed = true;
  }

  let normalized: SpawnResult | null = null;
  try {
    normalized = adapter.normalizeResult(adapter.fixture.raw);
  } catch {
    normalized = null;
  }

  const fixture = adapter.fixture.expected;
  const finalMatches = normalized?.ok === fixture.ok && normalized?.text === fixture.text;
  const sessionObserved = normalized?.sessionId !== undefined ? "supported" : "unsupported";
  const costObserved = normalized?.costUsd !== undefined ? "supported" : "unsupported";
  const hookSpec =
    adapter.profile.id in HARNESS_SPECS
      ? HARNESS_SPECS[adapter.profile.id as keyof typeof HARNESS_SPECS]
      : undefined;
  const hookSubcommands = new Set(hookSpec?.events.map((event) => event.subcommand) ?? []);

  return {
    invocation:
      !planningFailed && argv[0] === profile.binary && argv.includes(request.prompt)
        ? "supported"
        : "unsupported",
    modelSelection:
      !planningFailed && argv.includes(request.model ?? "") ? "supported" : "unsupported",
    effortSelection:
      effort === undefined
        ? "unsupported"
        : !planningFailed && argv.some((arg) => arg.includes(effort))
          ? "supported"
          : "unsupported",
    maxTurns:
      !planningFailed && argv.includes(String(request.maxTurns)) ? "supported" : "unsupported",
    finalResult: finalMatches ? "supported" : "unsupported",
    sessionId:
      sessionObserved === "supported" && normalized?.sessionId !== fixture.sessionId
        ? "unsupported"
        : sessionObserved,
    cost:
      costObserved === "supported" && normalized?.costUsd !== fixture.costUsd
        ? "unsupported"
        : costObserved,
    toolEvidence: normalized && "toolEvidence" in normalized ? "supported" : "unsupported",
    policyMapping: "unknown",
    interruption: "unknown",
    streaming: "unknown",
    steering: "unknown",
    resume: "unknown",
    images: "unknown",
    contextTelemetry: "unknown",
    preCompactionSignal: hookSpec
      ? hookSubcommands.has("pre-compact")
        ? "supported"
        : "unsupported"
      : "unknown",
    postCompactionSignal: hookSpec
      ? hookSubcommands.has("post-compact") ||
        (adapter.profile.id === "claude-code" && hookSubcommands.has("session-start"))
        ? "supported"
        : "unsupported"
      : "unknown",
    compaction: "unknown",
  };
}

function reconcile(declared: CapabilitySupport, observed: BenchVerdict): BenchVerdict {
  if (observed === "unknown" || observed === "skipped" || observed === "not_applicable") {
    return observed;
  }
  return declared === observed ? observed : "drift";
}

function probeVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split("\n")[0] || "installed";
}
