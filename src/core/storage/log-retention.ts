import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  HARNERY_STRUCTURED_LOG_PROVIDER_ID,
  type HarneryRegisteredStorageFamily,
} from "./contract.ts";
import type {
  HarneryMaintenanceAction,
  HarneryMaintenanceProvider,
  HarneryMaintenanceProviderPlan,
} from "./maintenance.ts";
import {
  familyLogDirectory,
  logManifestFingerprint,
  pruneSealedLogSegment,
  readSegmentManifest,
  withFamilyLease,
} from "./segments.ts";

export const STRUCTURED_LOG_RETENTION_SCOPE = "structured-log-retention" as const;

export interface StructuredLogRetentionSegment {
  sequence: number;
  file: string;
  actual_bytes: number;
  content_sha256: string;
  sealed_at: string;
  age_expired: boolean;
}

export interface StructuredLogRetentionSnapshot {
  file: string;
  actual_bytes: number;
  recovery_breadcrumb: boolean;
}

export interface StructuredLogRetentionInspection {
  family_id: string;
  effective_policy: {
    max_bytes: number;
    max_age_ms: number;
    fingerprint: string;
    sources: { max_bytes: string; max_age_ms: string };
  } | null;
  usage: {
    managed_bytes: number;
    unmanaged_bytes: number;
    total_bytes: number;
    managed_files: number;
    unmanaged_files: number;
  };
  pressure: {
    state: "within_budget" | "over_budget" | "unknown";
    ratio: number | null;
    bytes_over: number | null;
    reason_codes: string[];
  };
  retention: {
    state: "active" | "blocked" | "unmanaged";
    enforcement: "manual" | "none";
    reason_codes: string[];
  };
  sealed_segments: StructuredLogRetentionSegment[];
  obsolete_snapshots: StructuredLogRetentionSnapshot[];
}

interface MutableUsage {
  managed_bytes: number;
  unmanaged_bytes: number;
  managed_files: number;
  unmanaged_files: number;
}

/** Read-only, non-creating inspection for command and maintenance callers. */
export function inspectStructuredLogRetention(
  family: HarneryRegisteredStorageFamily,
  now = new Date(),
): StructuredLogRetentionInspection {
  const usage: MutableUsage = {
    managed_bytes: 0,
    unmanaged_bytes: 0,
    managed_files: 0,
    unmanaged_files: 0,
  };
  const reasons = new Set<string>();
  const effective = family.effective_log_retention;
  const policy =
    effective?.state === "valid"
      ? {
          max_bytes: effective.max_bytes,
          max_age_ms: effective.max_age_ms,
          fingerprint: effective.effective_policy_fingerprint,
          sources: {
            max_bytes: effective.provenance.max_bytes.source,
            max_age_ms: effective.provenance.max_age_days.source,
          },
        }
      : null;
  if (!structuredSegmentCapable(family)) {
    return result(family.id, policy, usage, "unmanaged", "none", ["unsupported_log_family"]);
  }
  if (!policy) {
    return result(family.id, null, usage, "blocked", "none", ["effective_policy_invalid"]);
  }
  const directory = familyLogDirectory(family);
  if (!existsSync(directory)) {
    return result(family.id, policy, usage, "active", "manual", ["root_dormant"]);
  }
  try {
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      return result(family.id, policy, usage, "blocked", "none", ["unsafe_family_root"]);
    }
    const manifest = readSegmentManifest(directory, family);
    const knownRootFiles = new Set(["active.jsonl", "manifest.json", "metrics.json"]);
    for (const name of knownRootFiles) accountKnownFile(join(directory, name), usage, reasons);

    const listed = new Set(manifest.segments.map(({ file }) => file));
    const segments: StructuredLogRetentionSegment[] = [];
    for (const segment of manifest.segments) {
      const path = join(directory, ...segment.file.split("/"));
      const observed = safeRegularFile(path);
      if (!observed.safe) {
        reasons.add(observed.reason ?? "missing_manifest_segment");
        continue;
      }
      usage.managed_bytes += observed.bytes;
      usage.managed_files += 1;
      segments.push({
        sequence: segment.sequence,
        file: segment.file,
        actual_bytes: observed.bytes,
        content_sha256: segment.sha256,
        sealed_at: segment.sealed_at,
        age_expired: now.getTime() - Date.parse(segment.sealed_at) >= policy.max_age_ms,
      });
    }
    accountUnknownSegmentFiles(directory, listed, usage, reasons);
    const snapshots = accountManifestSnapshots(directory, manifest.next_sequence, usage, reasons);
    accountUnknownRootFiles(directory, knownRootFiles, usage);
    accountLeaseFiles(directory, usage, reasons);
    const blocker = [...reasons].some((reason) =>
      [
        "unsafe_family_root",
        "unsafe_managed_path",
        "hard_link_ambiguous",
        "missing_manifest_segment",
        "manifest_invalid",
        "recovery_breadcrumb_present",
      ].includes(reason),
    );
    const ageExpired = segments.some(({ age_expired }) => age_expired);
    const bytesOver = Math.max(0, usage.managed_bytes - policy.max_bytes);
    if (usage.unmanaged_bytes > 0) reasons.add("unmanaged_bytes_present");
    if (bytesOver > 0) reasons.add("managed_bytes_exceed_budget");
    if (ageExpired) reasons.add("age_expired");
    return {
      family_id: family.id,
      effective_policy: policy,
      usage: { ...usage, total_bytes: usage.managed_bytes + usage.unmanaged_bytes },
      pressure: {
        state: blocker ? "unknown" : bytesOver > 0 || ageExpired ? "over_budget" : "within_budget",
        ratio: blocker ? null : usage.managed_bytes / policy.max_bytes,
        bytes_over: blocker ? null : bytesOver,
        reason_codes: [...reasons].sort(),
      },
      retention: {
        state: blocker ? "blocked" : "active",
        enforcement: blocker ? "none" : "manual",
        reason_codes: [...reasons].sort(),
      },
      sealed_segments: segments,
      obsolete_snapshots: snapshots.filter(({ recovery_breadcrumb }) => !recovery_breadcrumb),
    };
  } catch {
    return result(family.id, policy, usage, "blocked", "none", ["manifest_invalid"]);
  }
}

export function createStructuredLogRetentionProvider(
  family: HarneryRegisteredStorageFamily,
): HarneryMaintenanceProvider {
  if (!structuredSegmentCapable(family)) {
    throw new Error(`family ${family.id} is not manifest-backed structured log storage`);
  }
  return {
    family_id: family.id,
    destructive_scope: STRUCTURED_LOG_RETENTION_SCOPE,
    plan: ({ budget, now }): HarneryMaintenanceProviderPlan => {
      const inspection = inspectStructuredLogRetention(family, now);
      if (
        inspection.retention.state !== "active" ||
        !inspection.effective_policy ||
        inspection.pressure.state === "unknown"
      ) {
        return { actions: [] };
      }
      const actions: HarneryMaintenanceAction[] = [];
      let files = 0;
      let bytes = 0;
      const add = (action: HarneryMaintenanceAction): boolean => {
        if (files + action.files > budget.max_files || bytes + action.bytes > budget.max_bytes) {
          return false;
        }
        actions.push(action);
        files += action.files;
        bytes += action.bytes;
        return true;
      };
      for (const snapshot of inspection.obsolete_snapshots) {
        const path = join(familyLogDirectory(family), ...snapshot.file.split("/"));
        if (
          !add(
            retentionAction(family, inspection.effective_policy.fingerprint, {
              action_id: `snapshot-${basename(snapshot.file, ".json")}`,
              kind: "prune-log-manifest-snapshot",
              target_ref: snapshot.file,
              files: 1,
              bytes: snapshot.actual_bytes,
              expected_sha256: sha256File(path),
            }),
          )
        ) {
          return { actions };
        }
      }
      let projected = inspection.usage.managed_bytes - actions.reduce((sum, x) => sum + x.bytes, 0);
      let predictedManifest = readSegmentManifest(familyLogDirectory(family), family);
      for (const segment of inspection.sealed_segments) {
        if (!segment.age_expired && projected <= inspection.effective_policy.max_bytes) break;
        const path = join(familyLogDirectory(family), ...segment.file.split("/"));
        const expectedManifestFingerprint = logManifestFingerprint(predictedManifest);
        const nextManifest = {
          ...predictedManifest,
          pruned_through_sequence: segment.sequence,
          segments: predictedManifest.segments.slice(1),
        };
        const action = retentionAction(family, inspection.effective_policy.fingerprint, {
          action_id: `segment-${String(segment.sequence).padStart(8, "0")}`,
          kind: "prune-log-segment",
          target_ref: segment.file,
          files: 1,
          bytes: segment.actual_bytes,
          expected_sha256: sha256File(path),
          metadata: {
            sequence: segment.sequence,
            content_sha256: segment.content_sha256,
            expected_manifest_fingerprint: expectedManifestFingerprint,
            result_manifest_fingerprint: logManifestFingerprint(nextManifest),
          },
        });
        if (!add(action)) break;
        predictedManifest = nextManifest;
        projected -= segment.actual_bytes;
      }
      return { actions };
    },
    apply: async ({ action }) => {
      const current = family.effective_log_retention;
      if (
        current?.state !== "valid" ||
        action.authorization_scope !== STRUCTURED_LOG_RETENTION_SCOPE ||
        action.effective_policy_fingerprint !== current.effective_policy_fingerprint
      ) {
        return { outcome: "refused", detail: "effective log retention policy changed" };
      }
      if (action.kind === "prune-log-segment") {
        const sequence = Number(action.metadata?.sequence);
        const contentSha256 = String(action.metadata?.content_sha256 ?? "");
        const expectedManifestFingerprint = String(
          action.metadata?.expected_manifest_fingerprint ?? "",
        );
        const resultManifestFingerprint = String(
          action.metadata?.result_manifest_fingerprint ?? "",
        );
        const outcome = await pruneSealedLogSegment({
          directory: familyLogDirectory(family),
          family,
          sequence,
          file: action.target_ref,
          expected_bytes: action.bytes,
          expected_file_sha256: action.expected_sha256 ?? "",
          expected_content_sha256: contentSha256,
          expected_manifest_fingerprint: expectedManifestFingerprint,
          result_manifest_fingerprint: resultManifestFingerprint,
        });
        return { outcome };
      }
      if (action.kind === "prune-log-manifest-snapshot") {
        return {
          outcome: await pruneObsoleteSnapshot(
            family,
            action.target_ref,
            action.bytes,
            action.expected_sha256 ?? "",
          ),
        };
      }
      return { outcome: "refused", detail: "unsupported structured-log retention action" };
    },
  };
}

function structuredSegmentCapable(family: HarneryRegisteredStorageFamily): boolean {
  return (
    family.provider.provider_id === HARNERY_STRUCTURED_LOG_PROVIDER_ID &&
    (family.storage_class === "operational-log" || family.storage_class === "debug-log") &&
    family.format === "jsonl" &&
    family.resolved_roots.some(
      (root) => root.match === "provider-partition" && root.ownership !== "external",
    )
  );
}

function retentionAction(
  family: HarneryRegisteredStorageFamily,
  fingerprint: string,
  action: Omit<
    HarneryMaintenanceAction,
    "family_id" | "destructive" | "authorization_scope" | "effective_policy_fingerprint"
  >,
): HarneryMaintenanceAction {
  return {
    ...action,
    family_id: family.id,
    destructive: true,
    authorization_scope: STRUCTURED_LOG_RETENTION_SCOPE,
    effective_policy_fingerprint: fingerprint,
  };
}

async function pruneObsoleteSnapshot(
  family: HarneryRegisteredStorageFamily,
  relativePath: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<"applied" | "already_applied"> {
  if (!/^manifests\/[0-9]{8}\.json$/.test(relativePath)) {
    throw new Error("invalid log manifest snapshot target");
  }
  const directory = familyLogDirectory(family);
  return withFamilyLease(
    directory,
    {
      lease_timeout_ms: family.lease_policy?.acquisition_timeout_ms ?? 2_000,
      lease_retry_ms: family.lease_policy?.retry_backoff_ms ?? 10,
      lease_stale_ms: family.lease_policy?.stale_owner_ms ?? 30_000,
    },
    () => {
      const manifest = readSegmentManifest(directory, family);
      const sequence = Number(basename(relativePath, ".json"));
      if (sequence >= manifest.next_sequence) {
        throw new Error("log retention preserves an uncommitted recovery breadcrumb");
      }
      const path = join(directory, ...relativePath.split("/"));
      if (!existsSync(path)) return "already_applied";
      assertExactFile(path, expectedBytes, expectedSha256);
      unlinkSync(path);
      return "applied";
    },
  );
}

function result(
  familyId: string,
  policy: StructuredLogRetentionInspection["effective_policy"],
  usage: MutableUsage,
  state: StructuredLogRetentionInspection["retention"]["state"],
  enforcement: StructuredLogRetentionInspection["retention"]["enforcement"],
  reasons: string[],
): StructuredLogRetentionInspection {
  return {
    family_id: familyId,
    effective_policy: policy,
    usage: { ...usage, total_bytes: usage.managed_bytes + usage.unmanaged_bytes },
    pressure: {
      state: state === "active" ? "within_budget" : "unknown",
      ratio: state === "active" && policy ? 0 : null,
      bytes_over: state === "active" && policy ? 0 : null,
      reason_codes: [...new Set(reasons)].sort(),
    },
    retention: {
      state,
      enforcement,
      reason_codes: [...new Set(reasons)].sort(),
    },
    sealed_segments: [],
    obsolete_snapshots: [],
  };
}

function accountKnownFile(path: string, usage: MutableUsage, reasons: Set<string>): void {
  if (!existsSync(path)) return;
  const observed = safeRegularFile(path);
  if (!observed.safe) {
    reasons.add(observed.reason ?? "unsafe_managed_path");
    return;
  }
  usage.managed_bytes += observed.bytes;
  usage.managed_files += 1;
}

function accountUnknownSegmentFiles(
  directory: string,
  listed: ReadonlySet<string>,
  usage: MutableUsage,
  reasons: Set<string>,
): void {
  const root = join(directory, "segments");
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    reasons.add("unsafe_managed_path");
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = `segments/${entry.name}`;
    if (listed.has(relativePath)) continue;
    accountUnmanaged(join(root, entry.name), usage);
  }
}

function accountManifestSnapshots(
  directory: string,
  nextSequence: number,
  usage: MutableUsage,
  reasons: Set<string>,
): StructuredLogRetentionSnapshot[] {
  const root = join(directory, "manifests");
  if (!existsSync(root)) return [];
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    reasons.add("unsafe_managed_path");
    return [];
  }
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9]{8}\.json$/.test(entry.name)) {
      accountUnmanaged(join(root, entry.name), usage);
    }
  }
  const names = entries
    .filter((entry) => entry.isFile() && /^[0-9]{8}\.json$/.test(entry.name))
    .map((entry) => `manifests/${entry.name}`)
    .sort();
  return names.flatMap((relativePath) => {
    const observed = safeRegularFile(join(directory, ...relativePath.split("/")));
    if (!observed.safe) {
      reasons.add(observed.reason ?? "unsafe_managed_path");
      return [];
    }
    usage.managed_bytes += observed.bytes;
    usage.managed_files += 1;
    const recoveryBreadcrumb = Number(basename(relativePath, ".json")) >= nextSequence;
    if (recoveryBreadcrumb) reasons.add("recovery_breadcrumb_present");
    return [
      {
        file: relativePath,
        actual_bytes: observed.bytes,
        recovery_breadcrumb: recoveryBreadcrumb,
      },
    ];
  });
}

function accountUnknownRootFiles(
  directory: string,
  known: ReadonlySet<string>,
  usage: MutableUsage,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (known.has(entry.name) || ["segments", "manifests", ".append-lease"].includes(entry.name)) {
      continue;
    }
    accountUnmanaged(join(directory, entry.name), usage);
  }
}

function accountLeaseFiles(directory: string, usage: MutableUsage, reasons: Set<string>): void {
  const lease = join(directory, ".append-lease");
  if (!existsSync(lease)) return;
  try {
    const stat = lstatSync(lease);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      reasons.add("unsafe_managed_path");
      return;
    }
    for (const entry of readdirSync(lease, { withFileTypes: true })) {
      accountKnownFile(join(lease, entry.name), usage, reasons);
    }
  } catch {
    // A writer may release the lease during this read-only observation.
  }
}

function accountUnmanaged(path: string, usage: MutableUsage): void {
  try {
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink()) usage.unmanaged_bytes += stat.size;
    usage.unmanaged_files += 1;
  } catch {
    // Concurrent disappearance contributes no retained bytes.
  }
}

function safeRegularFile(path: string): { safe: boolean; bytes: number; reason?: string } {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { safe: false, bytes: 0, reason: "unsafe_managed_path" };
    }
    if (stat.nlink !== 1) return { safe: false, bytes: 0, reason: "hard_link_ambiguous" };
    return { safe: true, bytes: stat.size };
  } catch (error) {
    return {
      safe: false,
      bytes: 0,
      reason:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing_manifest_segment"
          : "unsafe_managed_path",
    };
  }
}

function assertExactFile(path: string, expectedBytes: number, expectedSha256: string): void {
  const observed = safeRegularFile(path);
  if (!observed.safe) throw new Error(observed.reason ?? "unsafe log retention source");
  if (observed.bytes !== expectedBytes) throw new Error("log retention source size changed");
  if (sha256File(path) !== expectedSha256) throw new Error("log retention source digest changed");
}

function sha256File(path: string): string {
  const parent = realpathSync(dirname(path));
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const actual = realpathSync(path);
    const rel = relative(parent, actual);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("log retention path escaped");
    return createHash("sha256").update(readFileSync(fd)).digest("hex");
  } finally {
    closeSync(fd);
  }
}
