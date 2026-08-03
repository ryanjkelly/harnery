import { spawnSync } from "node:child_process";
import { ADAPTER_SPECS } from "../hooks/adapter/events.ts";
import type { SpawnRequest, SpawnResult } from "../workflow/types.ts";
import type { AdapterAttestation, AttestableDimension } from "./attestation.ts";
import { isAttestationCurrent, readAttestation } from "./attestation.ts";
import type { AdapterRegistry } from "./registry.ts";
import type { Adapter, AdapterCapabilityDimension, AdapterId, CapabilitySupport } from "./types.ts";
import { ADAPTER_CAPABILITY_DIMENSIONS } from "./types.ts";

export type BenchVerdict =
  | "supported"
  | "partial"
  | "unsupported"
  | "not_applicable"
  | "unknown"
  | "skipped"
  | "drift";

export type BenchDimension = "registration" | "binary" | "contract" | AdapterCapabilityDimension;

/** How a result was established (ADR 0037). Orthogonal to the verdict: this
 * answers "how do we know", not "what is true".
 *
 * - `adapter`: checked against Harnery's own planner, normalizer, or fixture.
 *   Proves the adapter contract, says nothing about the installed vendor CLI.
 * - `attested`: checked by observing the installed vendor CLI on this host.
 * - `declared`: not checked. The value is the declaration, repeated. */
export type BenchBasis = "adapter" | "attested" | "declared";

export interface BenchResult {
  adapter: AdapterId;
  dimension: BenchDimension;
  declared: CapabilitySupport | "not_applicable";
  observed: BenchVerdict;
  verdict: BenchVerdict;
  basis: BenchBasis;
  note?: string;
}

export interface AdapterBenchReport {
  generatedAt: string;
  mode: "offline";
  adapters: AdapterId[];
  results: BenchResult[];
  summary: Record<BenchVerdict, number>;
  /** Result counts per basis, so a caller can tell a clean report from an
   * unmeasured one without walking every result. */
  basisSummary: Record<BenchBasis, number>;
  drift: boolean;
  skipped: boolean;
}

export interface AdapterBenchOptions {
  adapters?: readonly string[];
  dimensions?: readonly AdapterCapabilityDimension[];
  /** Test seam and alternate host probe. A null version means unavailable. */
  versionProbe?: (binary: string) => string | null;
  /** Where to look for live attestations (ADR 0038). Defaults to the coord
   * root. Reading them never runs a model turn. */
  coordRoot?: string;
  /** Test seam. Defaults to reading the attestation store. */
  attestationReader?: (adapter: AdapterId) => AdapterAttestation | null;
  /** Only cite attestations recorded under this billing mode. Omitted means
   * any mode is acceptable for reporting purposes. */
  subscriptionOnly?: boolean;
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

const EMPTY_BASIS_SUMMARY: Record<BenchBasis, number> = {
  adapter: 0,
  attested: 0,
  declared: 0,
};

/** A stored attestation only counts when it still matches the installed
 * version and the current declaration. A stale one is ignored rather than
 * trusted, so an upgraded vendor CLI silently drops back to adapter basis. */
function loadAttestation(
  id: AdapterId,
  version: string | null,
  adapter: Adapter,
  opts: AdapterBenchOptions,
): AdapterAttestation | null {
  let record: AdapterAttestation | null = null;
  try {
    record = opts.attestationReader
      ? opts.attestationReader(id)
      : readAttestation(id, { coordRoot: opts.coordRoot });
  } catch {
    // No coord root, unreadable store: the bench still runs, just unattested.
    return null;
  }
  return isAttestationCurrent(record, version, adapter.profile, opts.subscriptionOnly)
    ? record
    : null;
}

/** First version-shaped token in a string, or null when there is none.
 * Tolerates the vendor prefixes and suffixes real CLIs print, so
 * `codex-cli 0.144.5` and `2.1.197 (Claude Code)` both reduce to a token. */
function versionToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/\d+(?:\.\d+)+(?:[-.][0-9a-z]+)*/i);
  return match ? match[0].toLowerCase() : null;
}

export function runAdapterBench(
  registry: AdapterRegistry,
  opts: AdapterBenchOptions = {},
): AdapterBenchReport {
  const ids = opts.adapters?.length ? [...opts.adapters] : registry.ids();
  const dimensions = opts.dimensions?.length
    ? [...new Set(opts.dimensions)]
    : [...ADAPTER_CAPABILITY_DIMENSIONS];
  const versionProbe = opts.versionProbe ?? probeBinaryVersion;
  const results: BenchResult[] = [];

  for (const id of ids) {
    const adapter = registry.require(id);
    results.push({
      adapter: id,
      dimension: "registration",
      declared: "supported",
      observed: "supported",
      verdict: "supported",
      basis: "adapter",
      note: `${adapter.profile.integrationMode}; ${adapter.profile.authModel}`,
    });

    const version = versionProbe(adapter.profile.binary);
    results.push({
      adapter: id,
      dimension: "binary",
      declared: "supported",
      observed: version ? "supported" : "skipped",
      verdict: version ? "supported" : "skipped",
      // A skip establishes nothing about the vendor, so it is not an attestation.
      basis: version ? "attested" : "declared",
      note: version ?? `${adapter.profile.binary} not found on PATH`,
    });

    results.push(contractResult(id, adapter, version));

    const observations = observeAdapter(adapter);
    const attestation = loadAttestation(id, version, adapter, opts);
    for (const dimension of dimensions) {
      const claim = adapter.profile.capabilities[dimension];
      const live = attestation?.observations[dimension as AttestableDimension];
      // A live observation of the installed CLI outranks a fixture check of
      // Harnery's own normalizer. Everything else keeps its adapter basis.
      const { observed, basis }: DimensionObservation = live
        ? { observed: live, basis: "attested" }
        : observations[dimension];
      results.push({
        adapter: id,
        dimension,
        declared: claim.support,
        observed,
        verdict: reconcile(claim.support, observed),
        basis,
        note: live ? `attested on ${attestation?.binary_version}` : claim.note,
      });
    }
  }

  const summary = { ...EMPTY_SUMMARY };
  const basisSummary = { ...EMPTY_BASIS_SUMMARY };
  for (const result of results) {
    summary[result.verdict]++;
    basisSummary[result.basis]++;
  }
  return {
    generatedAt: new Date().toISOString(),
    mode: "offline",
    adapters: ids,
    results,
    summary,
    basisSummary,
    drift: summary.drift > 0,
    skipped: summary.skipped > 0,
  };
}

/** Compare the vendor contract a declaration was validated against with the
 * one actually installed (ADR 0037). This is the only dimension attested
 * without a model turn, because a version string costs nothing to read.
 *
 * A mismatch is `drift`, not failure: a newer vendor CLI is not automatically
 * broken, but the declaration is no longer backed by an observation. An
 * unrecorded or unparseable declared version stays `unknown` rather than being
 * inferred from the installed one. */
function contractResult(id: AdapterId, adapter: Adapter, version: string | null): BenchResult {
  const recorded = adapter.profile.verified;
  const base = { adapter: id, dimension: "contract" as const, declared: "supported" as const };

  if (!version) {
    return {
      ...base,
      observed: "skipped",
      verdict: "skipped",
      basis: "declared",
      note: `${adapter.profile.binary} not found on PATH; installed contract unobservable`,
    };
  }
  const declaredToken = versionToken(recorded?.version);
  if (!declaredToken) {
    return {
      ...base,
      observed: "unknown",
      verdict: "unknown",
      basis: "declared",
      note: recorded
        ? `verified.version "${recorded.version}" is not a version; installed ${version}`
        : `no verified vendor contract recorded; installed ${version}`,
    };
  }
  const installedToken = versionToken(version) ?? version.trim().toLowerCase();
  if (installedToken === declaredToken) {
    return {
      ...base,
      observed: "supported",
      verdict: "supported",
      basis: "attested",
      note: `declaration validated against ${recorded?.version} on ${recorded?.date}`,
    };
  }
  return {
    ...base,
    observed: "drift",
    verdict: "drift",
    basis: "attested",
    note: `declaration validated against ${recorded?.version} (${recorded?.date}); installed ${version}`,
  };
}

interface DimensionObservation {
  observed: BenchVerdict;
  basis: BenchBasis;
}

/** Checked against Harnery's planner, normalizer, or fixture. */
function fromAdapter(observed: BenchVerdict): DimensionObservation {
  return { observed, basis: "adapter" };
}

/** No check exists for this dimension yet. */
const NOT_CHECKED: DimensionObservation = { observed: "unknown", basis: "declared" };

function observeAdapter(
  adapter: Adapter,
): Record<AdapterCapabilityDimension, DimensionObservation> {
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

  // Plan a second invocation carrying a filesystem policy. Offline this can only
  // show whether the adapter *renders* the projection, never whether the vendor
  // enforces it; enforcement needs the live probe (ADR 0041). An adapter that
  // declares no projection throws here, which is the correct rendering.
  let projectionRendered = false;
  try {
    const projected = adapter.buildInvocation(
      { ...request, filesystemPolicy: { mode: "read-only" } },
      "/harnery-bench/final.txt",
    ).argv;
    projectionRendered = projected.join(" ") !== argv.join(" ");
  } catch {
    projectionRendered = false;
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
    adapter.profile.id in ADAPTER_SPECS
      ? ADAPTER_SPECS[adapter.profile.id as keyof typeof ADAPTER_SPECS]
      : undefined;
  const hookSubcommands = new Set(hookSpec?.events.map((event) => event.subcommand) ?? []);

  return {
    invocation: fromAdapter(
      !planningFailed && argv[0] === profile.binary && argv.includes(request.prompt)
        ? "supported"
        : "unsupported",
    ),
    modelSelection: fromAdapter(
      !planningFailed && argv.includes(request.model ?? "") ? "supported" : "unsupported",
    ),
    effortSelection: fromAdapter(
      effort === undefined
        ? "unsupported"
        : !planningFailed && argv.some((arg) => arg.includes(effort))
          ? "supported"
          : "unsupported",
    ),
    maxTurns: fromAdapter(
      !planningFailed && argv.includes(String(request.maxTurns)) ? "supported" : "unsupported",
    ),
    finalResult: fromAdapter(finalMatches ? "supported" : "unsupported"),
    sessionId: fromAdapter(
      sessionObserved === "supported" && normalized?.sessionId !== fixture.sessionId
        ? "unsupported"
        : sessionObserved,
    ),
    cost: fromAdapter(
      costObserved === "supported" && normalized?.costUsd !== fixture.costUsd
        ? "unsupported"
        : costObserved,
    ),
    toolEvidence: fromAdapter(
      normalized && "toolEvidence" in normalized ? "supported" : "unsupported",
    ),
    policyMapping: NOT_CHECKED,
    filesystemPolicyProjection: fromAdapter(projectionRendered ? "supported" : "unsupported"),
    interruption: NOT_CHECKED,
    streaming: NOT_CHECKED,
    steering: NOT_CHECKED,
    resume: NOT_CHECKED,
    images: NOT_CHECKED,
    contextTelemetry: NOT_CHECKED,
    preCompactionSignal: hookSpec
      ? fromAdapter(hookSubcommands.has("pre-compact") ? "supported" : "unsupported")
      : NOT_CHECKED,
    postCompactionSignal: hookSpec
      ? fromAdapter(
          hookSubcommands.has("post-compact") ||
            (adapter.profile.id === "claude-code" && hookSubcommands.has("session-start"))
            ? "supported"
            : "unsupported",
        )
      : NOT_CHECKED,
    compaction: NOT_CHECKED,
  };
}

function reconcile(declared: CapabilitySupport, observed: BenchVerdict): BenchVerdict {
  if (observed === "unknown" || observed === "skipped" || observed === "not_applicable") {
    return observed;
  }
  return declared === observed ? observed : "drift";
}

/** Ask an installed vendor CLI what version it is. Null when it is absent or
 * refuses to answer. Shared with the live attestation probe so both halves of
 * the capability story key on the same string. */
export function probeBinaryVersion(binary: string): string | null {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split("\n")[0] || "installed";
}
