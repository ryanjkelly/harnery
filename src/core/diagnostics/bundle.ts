import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type {
  ArtifactActor,
  ArtifactInventoryEntry,
  ArtifactManifestV1,
} from "../artifacts/index.ts";
import {
  ARTIFACT_MANIFEST,
  ARTIFACT_SCHEMA_VERSION,
  artifactsRoot,
  configuredArtifactRetentionDays,
  createArtifact,
  inventoryArtifacts,
  releaseArtifact,
  resolveArtifactRef,
} from "../artifacts/index.ts";
import { currentHarneryRuntimeBuild } from "../events/v3/runtime-build.ts";
import { writePrivateJsonAtomic } from "../storage/atomic-json.ts";
import {
  SUPERVISOR_DIAGNOSTIC_LIMITS,
  SUPERVISOR_EXPLANATION_SCHEMA_VERSION,
  SUPERVISOR_FINDING_POLICY,
  SUPERVISOR_FINDING_SCHEMA_VERSION,
  SUPERVISOR_RESOURCE_BUDGET,
  SUPERVISOR_TIMELINE_SCHEMA_VERSION,
  type SupervisorCapability,
  type SupervisorFinding,
} from "../supervisor/contract.ts";
import { readWorkflowProof } from "../workflow/proof.ts";
import {
  DIAGNOSTIC_ADVICE_LIMITS,
  DIAGNOSTIC_ADVICE_SCHEMA_VERSION,
  DIAGNOSTIC_BUNDLE_FILES,
  DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
  DIAGNOSTIC_COMMAND_SCHEMA_VERSION,
  DIAGNOSTIC_EXPECTED_SCHEMA_VERSION,
  DIAGNOSTIC_INPUT_SCHEMA_VERSION,
  DIAGNOSTIC_SUMMARY_SCHEMA_VERSION,
  type DiagnosticBundleFile,
  type DiagnosticBundleManifest,
  type DiagnosticCapturedSource,
  type DiagnosticObservations,
  type DiagnosticReplayResult,
  type DiagnosticSelection,
  type DiagnosticSummary,
  type DiagnosticThresholds,
  type ValidatedDiagnosticBundle,
} from "./contract.ts";
import { pseudonymousMachineId } from "./identity.ts";
import { canonicalJson, deriveCapturedExpected, replayDiagnosticInputs, sha256 } from "./replay.ts";
import { type SanitizationStats, sanitizeDiagnosticValue } from "./sanitize.ts";

const SOURCE_FILE_LIMIT_BYTES = 1_500_000;
const DEFAULT_WINDOW_MS = 15 * 60 * 1_000;
const SHADOW_ADMISSION_CAPTURE_LIMIT = 20;
const PAYLOAD_FILES = DIAGNOSTIC_BUNDLE_FILES.filter(
  (path): path is Exclude<(typeof DIAGNOSTIC_BUNDLE_FILES)[number], "diagnostic-manifest.json"> =>
    path !== "diagnostic-manifest.json",
);

const SOURCE_SPECS = [
  ["supervisor.snapshot", ".harnery/supervisor/snapshot.json"],
  ["supervisor.history", ".harnery/supervisor/history.json"],
  ["supervisor.findings", ".harnery/supervisor/findings.json"],
  ["supervisor.activity", ".harnery/supervisor/activity.json"],
  ["supervisor.timelines", ".harnery/supervisor/timelines"],
  ["supervisor.explanations", ".harnery/supervisor/explanations"],
  ["supervisor.log-feed", ".harnery/supervisor/log-feed.json"],
  ["supervisor.hook-health", ".harnery/supervisor/hook-health.json"],
  ["resources.snapshot", ".harnery/resources/snapshot.json"],
  ["coordination.health", ".harnery/supervisor/coordination-health.json"],
] as const;

export interface CaptureDiagnosticBundleInput {
  findingId?: string;
  startAt?: string;
  endAt?: string;
  actor?: ArtifactActor;
  retentionDays?: number;
  now?: Date;
  machineLabel?: string;
  engineVersion?: string;
}

export interface CapturedDiagnosticBundle {
  path: string;
  manifest: DiagnosticBundleManifest;
  summary: DiagnosticSummary;
}

export interface DiagnosticBundleListRow {
  artifact_id: string;
  created_at: string;
  expires_at: string | null;
  classification: ArtifactInventoryEntry["classification"];
  valid: boolean;
  captured_at?: string;
  finding_id?: string;
  error?: string;
}

export interface DiagnosticBundleCandidateRow {
  artifact_id: string;
  created_at: string;
  expires_at: string | null;
  classification: ArtifactInventoryEntry["classification"];
  selectable: boolean;
  captured_at?: string;
  finding_id?: string;
  error?: string;
}

export function captureDiagnosticBundle(
  repoRootRaw: string,
  input: CaptureDiagnosticBundleInput = {},
): CapturedDiagnosticBundle {
  const repoRoot = resolve(repoRootRaw);
  const now = input.now ?? new Date();
  assertValidDate(now, "now");
  const capturedAt = now.toISOString();
  const aggregateStats: SanitizationStats = { sanitized_value_count: 0, omitted_value_count: 0 };
  const sources = [
    ...SOURCE_SPECS.map(([sourceKind, relativePath]) =>
      readCapturedSource(repoRoot, sourceKind, relativePath, aggregateStats),
    ),
    readShadowAdmissionSource(repoRoot, capturedAt, aggregateStats),
  ];
  const selection = diagnosticSelection(input, sources, now);
  const observations: DiagnosticObservations = {
    schema_version: DIAGNOSTIC_INPUT_SCHEMA_VERSION,
    captured_at: capturedAt,
    selection,
    sources,
  };
  const thresholds: DiagnosticThresholds = {
    schema_version: DIAGNOSTIC_INPUT_SCHEMA_VERSION,
    values: {
      diagnostic_limits: SUPERVISOR_DIAGNOSTIC_LIMITS,
      finding_policy: SUPERVISOR_FINDING_POLICY,
      resource_budget: SUPERVISOR_RESOURCE_BUDGET,
    },
  };
  const expected = deriveCapturedExpected(observations, thresholds);
  if (input.findingId && !expected.findings.some((finding) => finding.id === input.findingId)) {
    throw new Error(
      `finding "${input.findingId}" is not present in the captured findings projection`,
    );
  }

  const created = createArtifact(repoRoot, {
    slug: "diagnostic-bundle",
    purpose: input.findingId
      ? `Frozen diagnostics for finding ${input.findingId}`
      : `Frozen diagnostics from ${selection.start_at} to ${selection.end_at}`,
    retentionDays: input.retentionDays ?? configuredArtifactRetentionDays(repoRoot),
    actor: input.actor,
    now,
  });
  const inputsPath = join(created.path, "inputs");
  mkdirSync(inputsPath, { recursive: true, mode: 0o700 });
  tryChmod(inputsPath, 0o700);

  const payloads: Record<(typeof PAYLOAD_FILES)[number], unknown> = {
    "inputs/observations.json": observations,
    "inputs/thresholds.json": thresholds,
    "expected.json": expected,
    "summary.json": {},
  };
  const summaryBase: Omit<DiagnosticSummary, "total_bytes"> = {
    schema_version: DIAGNOSTIC_SUMMARY_SCHEMA_VERSION,
    artifact_id: created.manifest.artifact_id,
    captured_at: capturedAt,
    machine_id: pseudonymousMachineId(input.machineLabel),
    machine_id_kind: "pseudonymous",
    selection,
    source_count: sources.length,
    supported_source_count: sources.filter((source) => source.capability === "supported").length,
    sanitized_value_count: aggregateStats.sanitized_value_count,
    omitted_value_count: aggregateStats.omitted_value_count,
  };
  const summary = stableSummary(summaryBase, payloads);
  payloads["summary.json"] = summary;

  for (const path of PAYLOAD_FILES)
    writePrivateJsonAtomic(join(created.path, path), payloads[path]);
  const files = PAYLOAD_FILES.map((path) => describeFile(created.path, path));
  const capabilities = sources.map(sourceCapability);
  const manifest: DiagnosticBundleManifest = {
    schema_version: DIAGNOSTIC_BUNDLE_SCHEMA_VERSION,
    artifact_id: created.manifest.artifact_id,
    captured_at: capturedAt,
    machine_id: summary.machine_id,
    finding_id: input.findingId,
    time_range: { start_at: selection.start_at, end_at: selection.end_at },
    engine_version: input.engineVersion ?? currentHarneryRuntimeBuild(),
    threshold_digest: expected.threshold_digest,
    sources: sources.map((source) => ({
      source_kind: source.source_kind,
      schema_version: source.schema_version,
      capability: source.capability,
      entry_count: countEntries(source.value),
      omitted_count: source.value === undefined ? 1 : 0,
      file: "inputs/observations.json",
    })),
    capabilities,
    files,
    replay: {
      input_file: "inputs/observations.json",
      thresholds_file: "inputs/thresholds.json",
      expected_file: "expected.json",
    },
  };
  writePrivateJsonAtomic(join(created.path, "diagnostic-manifest.json"), manifest);
  validateDiagnosticBundle(repoRoot, created.manifest.artifact_id);
  releaseArtifact(repoRoot, created.manifest.artifact_id, { actor: input.actor, now });
  return { path: created.path, manifest, summary };
}

function openDiagnosticBundleManifest(
  repoRootRaw: string,
  ref: string,
): { artifactPath: string; manifest: DiagnosticBundleManifest } {
  const repoRoot = resolve(repoRootRaw);
  const artifactPath = resolveArtifactRef(repoRoot, ref);
  const managedRoot = realpathSync(artifactsRoot(repoRoot));
  const resolvedArtifact = realpathSync(artifactPath);
  if (
    dirname(resolvedArtifact) !== managedRoot ||
    !resolvedArtifact.startsWith(`${managedRoot}${sep}`)
  ) {
    throw new Error("diagnostic bundle is outside the managed artifact root");
  }
  assertBundleTree(artifactPath);
  const artifactManifest = readCandidateArtifactManifest(artifactPath);
  const classification = candidateClassification(artifactManifest);
  if (
    !["managed-active", "managed-current", "managed-expired", "managed-tracked"].includes(
      classification,
    )
  ) {
    throw new Error(`diagnostic bundle has invalid managed classification ${classification}`);
  }
  if (artifactManifest.slug !== "diagnostic-bundle") {
    throw new Error("artifact is not a diagnostic bundle");
  }
  const manifest = readJson<DiagnosticBundleManifest>(artifactPath, "diagnostic-manifest.json");
  validateManifest(manifest, artifactManifest.artifact_id);
  return { artifactPath, manifest };
}

export function validateDiagnosticBundle(
  repoRootRaw: string,
  ref: string,
): ValidatedDiagnosticBundle {
  const { artifactPath, manifest } = openDiagnosticBundleManifest(repoRootRaw, ref);
  let totalBytes = 0;
  for (const file of manifest.files) {
    const bytes = readValidatedFile(artifactPath, file.path);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength !== file.bytes) throw new Error(`byte length mismatch for ${file.path}`);
    if (sha256(bytes) !== file.sha256) throw new Error(`digest mismatch for ${file.path}`);
  }
  if (totalBytes > SUPERVISOR_DIAGNOSTIC_LIMITS.max_bundle_bytes) {
    throw new Error("diagnostic bundle exceeds the maximum byte limit");
  }

  const observations = readJson<DiagnosticObservations>(artifactPath, manifest.replay.input_file);
  const thresholds = readJson<DiagnosticThresholds>(artifactPath, manifest.replay.thresholds_file);
  const expected = readJson<ValidatedDiagnosticBundle["expected"]>(
    artifactPath,
    manifest.replay.expected_file,
  );
  const summary = readJson<DiagnosticSummary>(artifactPath, "summary.json");
  validatePayloads(manifest, observations, thresholds, expected, summary);
  return { path: artifactPath, manifest, observations, thresholds, expected, summary };
}

/** Frozen web readers accept an opaque artifact id, never a filesystem path. */
export function readFrozenDiagnosticBundle(
  repoRoot: string,
  artifactId: string,
): ValidatedDiagnosticBundle {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(artifactId)) {
    throw new Error("diagnostic bundle id must be an opaque artifact id");
  }
  return validateDiagnosticBundle(repoRoot, artifactId);
}

export function showDiagnosticBundle(repoRoot: string, ref: string): ValidatedDiagnosticBundle {
  return validateDiagnosticBundle(repoRoot, ref);
}

export function listDiagnosticBundles(repoRoot: string): DiagnosticBundleListRow[] {
  return inventoryArtifacts(repoRoot)
    .filter((entry) => entry.slug === "diagnostic-bundle" && entry.artifact_id)
    .map((entry) => {
      try {
        const bundle = validateDiagnosticBundle(repoRoot, entry.artifact_id!);
        return {
          artifact_id: entry.artifact_id!,
          created_at: entry.created_at ?? bundle.manifest.captured_at,
          expires_at: entry.expires_at,
          classification: entry.classification,
          valid: true,
          captured_at: bundle.manifest.captured_at,
          finding_id: bundle.manifest.finding_id,
        };
      } catch (error) {
        return {
          artifact_id: entry.artifact_id!,
          created_at: entry.created_at ?? "",
          expires_at: entry.expires_at,
          classification: entry.classification,
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
}

/**
 * Lists managed bundle candidates without opening their bounded payloads.
 * Selection is not authority: every show, replay, and comparison operation
 * still performs complete digest and schema validation before returning data.
 */
export function listDiagnosticBundleCandidates(repoRoot: string): DiagnosticBundleCandidateRow[] {
  const root = artifactsRoot(repoRoot);
  if (!existsSync(root)) return [];
  const rows: DiagnosticBundleCandidateRow[] = [];
  for (const name of readdirSync(root).sort()) {
    const artifactPath = join(root, name);
    let artifactManifest: ArtifactManifestV1;
    try {
      const stat = lstatSync(artifactPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      artifactManifest = readCandidateArtifactManifest(artifactPath);
      if (artifactManifest.slug !== "diagnostic-bundle") continue;
      assertBundleTree(artifactPath);
      const manifest = readJson<DiagnosticBundleManifest>(artifactPath, "diagnostic-manifest.json");
      validateManifest(manifest, artifactManifest.artifact_id);
      rows.push({
        artifact_id: artifactManifest.artifact_id,
        created_at: artifactManifest.created_at,
        expires_at: artifactManifest.retention.expires_at,
        classification: candidateClassification(artifactManifest),
        selectable: true,
        captured_at: manifest.captured_at,
        finding_id: manifest.finding_id,
      });
    } catch (error) {
      if (!existsSync(join(artifactPath, "diagnostic-manifest.json"))) continue;
      const fallbackId = candidateArtifactId(artifactPath) ?? name;
      rows.push({
        artifact_id: fallbackId,
        created_at: "",
        expires_at: null,
        classification: "invalid-manifest",
        selectable: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.artifact_id, (counts.get(row.artifact_id) ?? 0) + 1);
  return rows.map((row) =>
    counts.get(row.artifact_id) === 1
      ? row
      : { ...row, selectable: false, error: "duplicate managed artifact id" },
  );
}

function readCandidateArtifactManifest(artifactPath: string): ArtifactManifestV1 {
  const manifestPath = join(artifactPath, ARTIFACT_MANIFEST);
  const stat = lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) {
    throw new Error("artifact manifest is not a bounded regular file");
  }
  let manifest: Partial<ArtifactManifestV1>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<ArtifactManifestV1>;
  } catch {
    throw new Error("artifact manifest is not valid JSON");
  }
  if (manifest.schema_version !== ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`unsupported artifact schema_version ${String(manifest.schema_version)}`);
  }
  if (
    typeof manifest.artifact_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(manifest.artifact_id)
  ) {
    throw new Error("invalid artifact_id");
  }
  if (typeof manifest.slug !== "string" || !manifest.slug) {
    throw new Error("invalid artifact slug");
  }
  if (typeof manifest.purpose !== "string" || !manifest.purpose.trim()) {
    throw new Error("invalid artifact purpose");
  }
  if (!validIsoTimestamp(manifest.created_at)) throw new Error("invalid artifact created_at");
  if (!manifest.retention || !validIsoTimestamp(manifest.retention.expires_at)) {
    throw new Error("invalid artifact retention");
  }
  if (manifest.released_at !== undefined && !validIsoTimestamp(manifest.released_at)) {
    throw new Error("invalid artifact released_at");
  }
  return manifest as ArtifactManifestV1;
}

function candidateArtifactId(artifactPath: string): string | undefined {
  try {
    return readCandidateArtifactManifest(artifactPath).artifact_id;
  } catch {
    return undefined;
  }
}

function candidateClassification(
  manifest: ArtifactManifestV1,
): ArtifactInventoryEntry["classification"] {
  if (!manifest.released_at) return "managed-active";
  return Date.parse(manifest.retention.expires_at) <= Date.now()
    ? "managed-expired"
    : "managed-current";
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function replayDiagnosticBundle(
  repoRoot: string,
  ref: string,
  now = new Date(),
): DiagnosticReplayResult {
  assertValidDate(now, "now");
  const bundle = validateDiagnosticBundle(repoRoot, ref);
  const actual = replayDiagnosticInputs(bundle.observations, bundle.thresholds);
  const expectedDigest = sha256(canonicalJson(bundle.expected));
  const actualDigest = sha256(canonicalJson(actual));
  return {
    schema_version: DIAGNOSTIC_COMMAND_SCHEMA_VERSION,
    artifact_id: bundle.manifest.artifact_id,
    replayed_at: now.toISOString(),
    matched: expectedDigest === actualDigest,
    threshold_digest: actual.threshold_digest,
    expected_digest: expectedDigest,
    actual_digest: actualDigest,
    finding_count: actual.findings.length,
  };
}

function readCapturedSource(
  repoRoot: string,
  sourceKind: string,
  relativePath: string,
  aggregateStats: SanitizationStats,
): DiagnosticCapturedSource {
  const path = join(repoRoot, relativePath);
  if (!existsSync(path)) {
    return { source_kind: sourceKind, capability: "unsupported", reason_code: "source_missing" };
  }
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("source_is_symlink");
    const parsed = stat.isDirectory()
      ? readJsonDirectory(path)
      : stat.isFile()
        ? readBoundedJsonFile(path)
        : (() => {
            throw new Error("source_is_not_regular_file");
          })();
    const sanitized = sanitizeDiagnosticValue(parsed);
    aggregateStats.sanitized_value_count += sanitized.stats.sanitized_value_count;
    aggregateStats.omitted_value_count += sanitized.stats.omitted_value_count;
    const value = sanitized.value;
    const record = object(value);
    return {
      source_kind: sourceKind,
      capability: "supported",
      schema_version: numeric(record?.schema_version),
      observed_at: timestamp(record),
      value,
    };
  } catch (error) {
    return {
      source_kind: sourceKind,
      capability: "error",
      reason_code: error instanceof Error ? error.message : String(error),
    };
  }
}

function readShadowAdmissionSource(
  repoRoot: string,
  capturedAt: string,
  aggregateStats: SanitizationStats,
): DiagnosticCapturedSource {
  const sourceKind = "workflow.diagnostic-admission";
  const workflowsRoot = join(repoRoot, ".harnery", "workflows");
  if (!existsSync(workflowsRoot)) {
    return { source_kind: sourceKind, capability: "unsupported", reason_code: "source_missing" };
  }
  try {
    const rootStat = lstatSync(workflowsRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("workflow_root_is_not_regular_directory");
    }
    const candidates = readdirSync(workflowsRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left));
    const records: Record<string, unknown>[] = [];
    let invalidCount = 0;
    const scanLimit = SHADOW_ADMISSION_CAPTURE_LIMIT * 2;
    for (const runId of candidates.slice(0, scanLimit)) {
      try {
        const proof = readWorkflowProof(repoRoot, runId);
        const admission = proof.diagnostic_admission;
        if (!admission) continue;
        records.push({
          run_id: proof.run.id,
          ended_at: proof.run.ended_at,
          state: admission.state,
          action: admission.action,
          ...(admission.reason_code ? { reason_code: admission.reason_code } : {}),
          ...(admission.observation
            ? {
                pressure: admission.observation.advice.pressure,
                fan_out_recommendation: admission.observation.advice.fan_out_recommendation,
                freshness: admission.observation.freshness,
                service_state: admission.observation.service_state,
                wait_ms: admission.observation.wait_ms,
              }
            : {}),
        });
        if (records.length >= SHADOW_ADMISSION_CAPTURE_LIMIT) break;
      } catch {
        invalidCount += 1;
      }
    }
    const omittedCount = Math.max(0, candidates.length - Math.min(candidates.length, scanLimit));
    const projection = {
      schema_version: 1,
      captured_at: capturedAt,
      max_records: SHADOW_ADMISSION_CAPTURE_LIMIT,
      examined_run_count: Math.min(candidates.length, scanLimit),
      omitted_run_count: omittedCount,
      invalid_run_count: invalidCount,
      records,
    };
    const sanitized = sanitizeDiagnosticValue(projection);
    aggregateStats.sanitized_value_count += sanitized.stats.sanitized_value_count;
    aggregateStats.omitted_value_count += sanitized.stats.omitted_value_count;
    return {
      source_kind: sourceKind,
      capability: omittedCount > 0 || invalidCount > 0 ? "partial" : "supported",
      schema_version: 1,
      observed_at: records[0]?.ended_at as string | undefined,
      value: sanitized.value,
      ...(omittedCount > 0
        ? { reason_code: "bounded_workflow_window_truncated" }
        : invalidCount > 0
          ? { reason_code: "invalid_workflow_proofs_ignored" }
          : {}),
    };
  } catch (error) {
    return {
      source_kind: sourceKind,
      capability: "error",
      reason_code: error instanceof Error ? error.message : String(error),
    };
  }
}

function readBoundedJsonFile(path: string): unknown {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("source_is_not_regular_file");
  if (stat.size > SOURCE_FILE_LIMIT_BYTES) throw new Error("source_exceeds_byte_limit");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readJsonDirectory(path: string): unknown[] {
  const values: unknown[] = [];
  let totalBytes = 0;
  const names = readdirSync(path).sort();
  if (names.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_findings) {
    throw new Error("source_directory_exceeds_entry_limit");
  }
  for (const name of names) {
    if (!/^[A-Za-z0-9_.-]+\.json$/.test(name)) {
      throw new Error("source_directory_contains_unexpected_entry");
    }
    const file = join(path, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("source_directory_contains_nonregular_file");
    }
    totalBytes += stat.size;
    if (totalBytes > SOURCE_FILE_LIMIT_BYTES) throw new Error("source_exceeds_byte_limit");
    values.push(readBoundedJsonFile(file));
  }
  return values;
}

function diagnosticSelection(
  input: CaptureDiagnosticBundleInput,
  sources: readonly DiagnosticCapturedSource[],
  now: Date,
): DiagnosticSelection {
  if ((input.startAt === undefined) !== (input.endAt === undefined)) {
    throw new Error("--from and --to must be supplied together");
  }
  if (input.findingId && input.startAt) {
    throw new Error("--finding cannot be combined with --from and --to");
  }
  if (input.findingId) {
    if (!/^[A-Za-z0-9_.:-]{1,240}$/.test(input.findingId)) throw new Error("invalid finding id");
    const finding = allFindings(sources).find((candidate) => candidate.id === input.findingId);
    if (!finding) {
      return {
        finding_id: input.findingId,
        start_at: now.toISOString(),
        end_at: now.toISOString(),
      };
    }
    return {
      finding_id: input.findingId,
      start_at: finding.opened_at,
      end_at: finding.resolved_at ?? finding.observed_at,
    };
  }
  const start = input.startAt
    ? parseIso(input.startAt, "--from")
    : new Date(now.getTime() - DEFAULT_WINDOW_MS);
  const end = input.endAt ? parseIso(input.endAt, "--to") : now;
  if (start.getTime() > end.getTime()) throw new Error("--from must not follow --to");
  return { start_at: start.toISOString(), end_at: end.toISOString() };
}

function allFindings(sources: readonly DiagnosticCapturedSource[]): SupervisorFinding[] {
  const value = sources.find((source) => source.source_kind === "supervisor.findings")?.value;
  const record = object(value);
  return [
    ...arrayObjects(record?.active),
    ...arrayObjects(record?.transitions),
  ] as unknown as SupervisorFinding[];
}

function sourceCapability(source: DiagnosticCapturedSource): SupervisorCapability {
  return {
    source_kind: source.source_kind,
    state: source.capability,
    reason_code: source.reason_code,
  };
}

function stableSummary(
  base: Omit<DiagnosticSummary, "total_bytes">,
  payloads: Record<(typeof PAYLOAD_FILES)[number], unknown>,
): DiagnosticSummary {
  let summary: DiagnosticSummary = { ...base, total_bytes: 0 };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const total = PAYLOAD_FILES.reduce((sum, path) => {
      const value = path === "summary.json" ? summary : payloads[path];
      return sum + Buffer.byteLength(`${JSON.stringify(value)}\n`);
    }, 0);
    if (total === summary.total_bytes) return summary;
    summary = { ...base, total_bytes: total };
  }
  return summary;
}

function describeFile(root: string, path: (typeof PAYLOAD_FILES)[number]): DiagnosticBundleFile {
  const bytes = readValidatedFile(root, path);
  return { path, media_type: "application/json", bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function assertBundleTree(root: string): void {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("diagnostic bundle root must be a regular directory");
  }
  const top = readdirSync(root).sort();
  const expectedTop = [
    ARTIFACT_MANIFEST,
    "diagnostic-manifest.json",
    "expected.json",
    "inputs",
    "summary.json",
  ].sort();
  if (top.join("\0") !== expectedTop.join("\0"))
    throw new Error("diagnostic bundle file set is not exact");
  const inputs = join(root, "inputs");
  const inputsStat = lstatSync(inputs);
  if (inputsStat.isSymbolicLink() || !inputsStat.isDirectory()) {
    throw new Error("diagnostic bundle inputs must be a regular directory");
  }
  const inputFiles = readdirSync(inputs).sort();
  if (inputFiles.join("\0") !== ["observations.json", "thresholds.json"].join("\0")) {
    throw new Error("diagnostic bundle input file set is not exact");
  }
  for (const path of [...PAYLOAD_FILES, "diagnostic-manifest.json"] as const) {
    readValidatedFile(root, path);
  }
}

function readValidatedFile(rootRaw: string, relativePath: string): Buffer {
  if (
    !PAYLOAD_FILES.includes(relativePath as never) &&
    relativePath !== "diagnostic-manifest.json"
  ) {
    throw new Error(`unexpected diagnostic bundle path ${relativePath}`);
  }
  const root = realpathSync(resolve(rootRaw));
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`))
    throw new Error(`path escapes diagnostic bundle: ${relativePath}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`${relativePath} is not a regular file`);
  const real = realpathSync(path);
  if (!real.startsWith(`${root}${sep}`))
    throw new Error(`path escapes diagnostic bundle: ${relativePath}`);
  if (stat.size > SUPERVISOR_DIAGNOSTIC_LIMITS.max_bundle_bytes) {
    throw new Error(`${relativePath} exceeds the maximum byte limit`);
  }
  return readFileSync(real);
}

function readJson<T>(root: string, relativePath: string): T {
  const bytes = readValidatedFile(root, relativePath);
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("root must be an object");
    }
    return value as T;
  } catch (error) {
    throw new Error(
      `${relativePath} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateManifest(manifest: DiagnosticBundleManifest, artifactId: string): void {
  assertKeys(
    manifest,
    [
      "schema_version",
      "artifact_id",
      "captured_at",
      "machine_id",
      "time_range",
      "engine_version",
      "threshold_digest",
      "sources",
      "capabilities",
      "files",
      "replay",
    ],
    ["finding_id"],
    "diagnostic manifest",
  );
  if (manifest.schema_version !== DIAGNOSTIC_BUNDLE_SCHEMA_VERSION)
    throw new Error("unsupported diagnostic manifest schema");
  if (manifest.artifact_id !== artifactId)
    throw new Error("diagnostic artifact id does not match managed artifact id");
  if (
    !validIso(manifest.captured_at) ||
    !validIso(manifest.time_range?.start_at) ||
    !validIso(manifest.time_range?.end_at)
  ) {
    throw new Error("diagnostic manifest has an invalid timestamp");
  }
  if (!/^machine_[0-9a-f]{64}$/.test(manifest.machine_id))
    throw new Error("diagnostic machine id is not pseudonymous");
  if (!/^[0-9a-f]{64}$/.test(manifest.threshold_digest))
    throw new Error("invalid threshold digest");
  if (
    typeof manifest.engine_version !== "string" ||
    !/^[0-9A-Za-z._+-]{1,100}$/.test(manifest.engine_version)
  ) {
    throw new Error("invalid diagnostic engine version");
  }
  assertSelection(manifest.time_range, "diagnostic manifest time range", false);
  if (
    !Array.isArray(manifest.sources) ||
    manifest.sources.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_capabilities
  ) {
    throw new Error("diagnostic manifest sources exceed the limit");
  }
  for (const source of manifest.sources) {
    assertKeys(
      source,
      ["source_kind", "capability", "entry_count", "omitted_count", "file"],
      ["schema_version"],
      "diagnostic manifest source",
    );
    if (!validSourceKind(source.source_kind) || !validCapabilityState(source.capability))
      throw new Error("invalid diagnostic manifest source");
    if (
      source.schema_version !== undefined &&
      (!Number.isInteger(source.schema_version) || source.schema_version < 0)
    )
      throw new Error("invalid diagnostic source schema version");
    if (
      !boundedInteger(source.entry_count, 0, 50_000) ||
      !boundedInteger(source.omitted_count, 0, 50_000) ||
      source.file !== "inputs/observations.json"
    )
      throw new Error("invalid diagnostic manifest source counts");
  }
  validateCapabilities(manifest.capabilities, "diagnostic manifest capabilities");
  if (!Array.isArray(manifest.files) || manifest.files.length !== PAYLOAD_FILES.length)
    throw new Error("diagnostic manifest file list is incomplete");
  const listed = manifest.files.map((file) => file.path).sort();
  if (listed.join("\0") !== [...PAYLOAD_FILES].sort().join("\0"))
    throw new Error("diagnostic manifest file list is not exact");
  for (const file of manifest.files) {
    assertKeys(file, ["path", "media_type", "bytes", "sha256"], [], "diagnostic file descriptor");
    if (
      file.media_type !== "application/json" ||
      !Number.isInteger(file.bytes) ||
      file.bytes < 1 ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error(`invalid diagnostic file descriptor for ${String(file.path)}`);
    }
  }
  assertKeys(
    manifest.replay,
    ["input_file", "thresholds_file", "expected_file"],
    [],
    "diagnostic replay contract",
  );
  if (
    manifest.replay?.input_file !== "inputs/observations.json" ||
    manifest.replay?.thresholds_file !== "inputs/thresholds.json" ||
    manifest.replay?.expected_file !== "expected.json"
  ) {
    throw new Error("diagnostic replay file contract is invalid");
  }
}

function validatePayloads(
  manifest: DiagnosticBundleManifest,
  observations: DiagnosticObservations,
  thresholds: DiagnosticThresholds,
  expected: ValidatedDiagnosticBundle["expected"],
  summary: DiagnosticSummary,
): void {
  assertKeys(
    observations,
    ["schema_version", "captured_at", "selection", "sources"],
    [],
    "diagnostic observations",
  );
  assertKeys(thresholds, ["schema_version", "values"], [], "diagnostic thresholds");
  assertKeys(
    expected,
    [
      "schema_version",
      "threshold_digest",
      "selection",
      "findings",
      "timelines",
      "explanations",
      "advice",
    ],
    [],
    "diagnostic expected output",
  );
  assertKeys(
    summary,
    [
      "schema_version",
      "artifact_id",
      "captured_at",
      "machine_id",
      "machine_id_kind",
      "selection",
      "source_count",
      "supported_source_count",
      "sanitized_value_count",
      "omitted_value_count",
      "total_bytes",
    ],
    [],
    "diagnostic summary",
  );
  if (
    observations.schema_version !== DIAGNOSTIC_INPUT_SCHEMA_VERSION ||
    thresholds.schema_version !== DIAGNOSTIC_INPUT_SCHEMA_VERSION
  ) {
    throw new Error("unsupported diagnostic input schema");
  }
  if (!Array.isArray(observations.sources) || !validIso(observations.captured_at))
    throw new Error("invalid diagnostic observations");
  if (observations.sources.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_capabilities)
    throw new Error("diagnostic observations exceed the source limit");
  assertSelection(observations.selection, "diagnostic observation selection", true);
  for (const source of observations.sources) {
    assertKeys(
      source,
      ["source_kind", "capability"],
      ["schema_version", "observed_at", "value", "reason_code"],
      "diagnostic captured source",
    );
    if (!validSourceKind(source.source_kind) || !validCapabilityState(source.capability))
      throw new Error("invalid diagnostic captured source");
    if (
      source.schema_version !== undefined &&
      (!Number.isInteger(source.schema_version) || source.schema_version < 0)
    )
      throw new Error("invalid captured source schema version");
    if (source.observed_at !== undefined && !validIso(source.observed_at))
      throw new Error("invalid captured source timestamp");
    if (
      source.reason_code !== undefined &&
      (typeof source.reason_code !== "string" || source.reason_code.length > 240)
    )
      throw new Error("invalid captured source reason code");
  }
  if (
    !thresholds.values ||
    typeof thresholds.values !== "object" ||
    Array.isArray(thresholds.values)
  )
    throw new Error("invalid diagnostic threshold values");
  if (expected.schema_version !== DIAGNOSTIC_EXPECTED_SCHEMA_VERSION)
    throw new Error("unsupported diagnostic expected schema");
  assertSelection(expected.selection, "diagnostic expected selection", true);
  if (canonicalJson(expected.selection) !== canonicalJson(observations.selection))
    throw new Error("diagnostic expected selection does not match inputs");
  validateExpectedRecords(expected);
  if (
    expected.threshold_digest !== sha256(canonicalJson(thresholds)) ||
    expected.threshold_digest !== manifest.threshold_digest
  ) {
    throw new Error("captured threshold digest does not match manifest");
  }
  if (
    summary.schema_version !== DIAGNOSTIC_SUMMARY_SCHEMA_VERSION ||
    summary.artifact_id !== manifest.artifact_id ||
    summary.machine_id !== manifest.machine_id ||
    summary.machine_id_kind !== "pseudonymous"
  ) {
    throw new Error("invalid diagnostic summary");
  }
  assertSelection(summary.selection, "diagnostic summary selection", true);
  for (const count of [
    summary.source_count,
    summary.supported_source_count,
    summary.sanitized_value_count,
    summary.omitted_value_count,
    summary.total_bytes,
  ]) {
    if (!boundedInteger(count, 0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_bundle_bytes))
      throw new Error("invalid diagnostic summary count");
  }
  if (
    summary.source_count !== observations.sources.length ||
    summary.supported_source_count > summary.source_count
  )
    throw new Error("diagnostic summary source counts do not match inputs");
}

function validateExpectedRecords(expected: ValidatedDiagnosticBundle["expected"]): void {
  if (
    !Array.isArray(expected.findings) ||
    expected.findings.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_findings
  )
    throw new Error("diagnostic expected findings exceed the limit");
  if (
    !Array.isArray(expected.timelines) ||
    expected.timelines.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_findings
  )
    throw new Error("diagnostic expected timelines exceed the limit");
  if (
    !Array.isArray(expected.explanations) ||
    expected.explanations.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_findings
  )
    throw new Error("diagnostic expected explanations exceed the limit");
  for (const finding of expected.findings) {
    if (
      !finding ||
      typeof finding !== "object" ||
      finding.schema_version !== SUPERVISOR_FINDING_SCHEMA_VERSION
    )
      throw new Error("invalid diagnostic expected finding schema");
    if (
      !Array.isArray(finding.evidence) ||
      finding.evidence.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_evidence_per_finding
    )
      throw new Error("diagnostic finding evidence exceeds the limit");
    validateCapabilities(finding.capabilities, "diagnostic finding capabilities");
  }
  for (const timeline of expected.timelines) {
    if (
      !timeline ||
      typeof timeline !== "object" ||
      timeline.schema_version !== SUPERVISOR_TIMELINE_SCHEMA_VERSION
    )
      throw new Error("invalid diagnostic timeline schema");
    if (
      !Array.isArray(timeline.entries) ||
      timeline.entries.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_timeline_entries
    )
      throw new Error("diagnostic timeline entries exceed the limit");
    validateCapabilities(timeline.capabilities, "diagnostic timeline capabilities");
    if (!boundedInteger(timeline.compacted_entries, 0, 50_000))
      throw new Error("invalid diagnostic timeline compaction count");
    for (const entry of timeline.entries) {
      if (
        !entry ||
        !validIso(entry.first_occurred_at) ||
        !validIso(entry.last_occurred_at) ||
        !boundedInteger(entry.occurrence_count, 1, 50_000) ||
        Date.parse(entry.first_occurred_at) > Date.parse(entry.last_occurred_at)
      ) {
        throw new Error("invalid diagnostic timeline entry cluster");
      }
    }
  }
  for (const explanation of expected.explanations) {
    if (
      !explanation ||
      typeof explanation !== "object" ||
      explanation.schema_version !== SUPERVISOR_EXPLANATION_SCHEMA_VERSION
    )
      throw new Error("invalid diagnostic explanation schema");
    for (const rows of [
      explanation.observed,
      explanation.related,
      explanation.possible,
      explanation.missing_capabilities,
    ]) {
      if (!Array.isArray(rows) || rows.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_explanation_items)
        throw new Error("diagnostic explanation entries exceed the limit");
    }
  }
  validateAdvice(expected.advice);
}

function validateAdvice(advice: ValidatedDiagnosticBundle["expected"]["advice"]): void {
  assertKeys(
    advice,
    [
      "schema_version",
      "evaluated_at",
      "pressure",
      "fan_out_recommendation",
      "observer_only",
      "summary",
      "source_capability",
      "active_finding_count",
      "contributing_finding_count",
      "omitted_contributing_finding_count",
      "contributing_findings",
      "reasons",
    ],
    [],
    "diagnostic advice",
  );
  if (
    advice.schema_version !== DIAGNOSTIC_ADVICE_SCHEMA_VERSION ||
    !validIso(advice.evaluated_at) ||
    !["normal", "elevated", "critical", "unknown"].includes(advice.pressure) ||
    !["proceed", "use-caution", "avoid-new-fan-out", "unknown"].includes(
      advice.fan_out_recommendation,
    ) ||
    advice.observer_only !== true ||
    typeof advice.summary !== "string" ||
    advice.summary.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_summary_chars
  ) {
    throw new Error("invalid diagnostic advice contract");
  }
  validateCapabilities([advice.source_capability], "diagnostic advice capability");
  for (const count of [
    advice.active_finding_count,
    advice.contributing_finding_count,
    advice.omitted_contributing_finding_count,
  ]) {
    if (!boundedInteger(count, 0, SUPERVISOR_DIAGNOSTIC_LIMITS.max_findings))
      throw new Error("invalid diagnostic advice count");
  }
  if (
    !Array.isArray(advice.contributing_findings) ||
    advice.contributing_findings.length > DIAGNOSTIC_ADVICE_LIMITS.max_contributing_findings ||
    !Array.isArray(advice.reasons) ||
    advice.reasons.length > DIAGNOSTIC_ADVICE_LIMITS.max_reasons
  ) {
    throw new Error("diagnostic advice entries exceed the limit");
  }
  for (const finding of advice.contributing_findings) {
    assertKeys(
      finding,
      [
        "finding_id",
        "finding_kind",
        "severity",
        "summary",
        "scope_kind",
        "scope_id",
        "occurrence_count",
      ],
      ["owner_kind", "owner_id", "workload_relationship"],
      "diagnostic advice finding",
    );
    if (
      !["warning", "critical"].includes(finding.severity) ||
      typeof finding.finding_id !== "string" ||
      typeof finding.summary !== "string" ||
      !boundedInteger(finding.occurrence_count, 1, 50_000)
    ) {
      throw new Error("invalid diagnostic advice finding");
    }
  }
  for (const reason of advice.reasons) {
    assertKeys(reason, ["code", "summary", "finding_ids"], [], "diagnostic advice reason");
    if (
      ![
        "critical_findings_active",
        "warning_findings_active",
        "findings_source_unavailable",
        "no_active_pressure_findings",
      ].includes(reason.code) ||
      typeof reason.summary !== "string" ||
      !Array.isArray(reason.finding_ids) ||
      reason.finding_ids.length > DIAGNOSTIC_ADVICE_LIMITS.max_contributing_findings ||
      reason.finding_ids.some((id: unknown) => typeof id !== "string")
    ) {
      throw new Error("invalid diagnostic advice reason");
    }
  }
}

function validateCapabilities(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length > SUPERVISOR_DIAGNOSTIC_LIMITS.max_capabilities)
    throw new Error(`${label} exceed the limit`);
  for (const capability of value) {
    if (!capability || typeof capability !== "object" || Array.isArray(capability))
      throw new Error(`invalid ${label}`);
    assertKeys(capability, ["source_kind", "state"], ["reason_code", "detail"], label);
    const record = capability as Record<string, unknown>;
    if (!validSourceKind(record.source_kind) || !validCapabilityState(record.state))
      throw new Error(`invalid ${label}`);
    if (
      record.reason_code !== undefined &&
      (typeof record.reason_code !== "string" || record.reason_code.length > 240)
    )
      throw new Error(`invalid ${label}`);
    if (
      record.detail !== undefined &&
      (typeof record.detail !== "string" || record.detail.length > 2_000)
    )
      throw new Error(`invalid ${label}`);
  }
}

function assertSelection(value: unknown, label: string, findingAllowed: boolean): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`invalid ${label}`);
  const record = value as Record<string, unknown>;
  assertKeys(record, ["start_at", "end_at"], findingAllowed ? ["finding_id"] : [], label);
  if (
    !validIso(record.start_at) ||
    !validIso(record.end_at) ||
    Date.parse(record.start_at as string) > Date.parse(record.end_at as string)
  )
    throw new Error(`invalid ${label}`);
  if (
    record.finding_id !== undefined &&
    (typeof record.finding_id !== "string" || !/^[A-Za-z0-9_.:-]{1,240}$/.test(record.finding_id))
  )
    throw new Error(`invalid ${label}`);
}

function assertKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !keys.includes(key));
  const unknown = keys.filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`${label} keys are invalid`);
  }
}

function validCapabilityState(value: unknown): boolean {
  return ["supported", "partial", "unsupported", "error"].includes(String(value));
}

function validSourceKind(value: unknown): boolean {
  return typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,119}$/.test(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

function countEntries(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const record = object(value);
  if (!record) return value === undefined ? 0 : 1;
  for (const key of ["active", "transitions", "points", "lanes", "rows"]) {
    if (Array.isArray(record[key])) return record[key].length;
  }
  return 1;
}

function timestamp(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  for (const key of ["captured_at", "sampled_at", "generated_at", "heartbeat_at"]) {
    if (validIso(record[key])) return record[key] as string;
  }
  return undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function arrayObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item) => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseIso(value: string, label: string): Date {
  const date = new Date(value);
  assertValidDate(date, label);
  return date;
}

function validIso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(`${label} must be a valid timestamp`);
}

function tryChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Windows does not expose POSIX modes. The private atomic writer still applies.
  }
}
