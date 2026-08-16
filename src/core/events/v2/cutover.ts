import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fsyncParentDirectory } from "../../workflow/durable-record.ts";
import { canonicalJsonV2, sha256V2 } from "./canonical.ts";
import { EVENT_V2_LEDGER_RELATIVE_ROOT } from "./writer.ts";

const V1_ACTIVE_RELATIVE_PATH = ".harnery/events.ndjson" as const;
const V1_FENCE_MARKER = "V1-SEALED.json" as const;
const MANIFEST_LIMIT = 2 * 1024 * 1024;
const OBJECT_LIMIT = 128 * 1024 * 1024;

export type CutoverV2Step =
  | "snapshot_manifest_committed"
  | "seal_intent_committed"
  | "v1_active_renamed"
  | "v1_fence_installed"
  | "seal_manifest_committed"
  | "rollback_intent_committed"
  | "v1_fence_removed"
  | "v1_continuation_created"
  | "projection_root_restored"
  | "rollback_record_committed";

export interface V1ActiveIdentityV2 {
  relative_path: typeof V1_ACTIVE_RELATIVE_PATH;
  device: string;
  inode: string;
  bytes: number;
  digest: `sha256:${string}`;
}

export interface ProjectionSnapshotEntryV2 {
  relative_path: string;
  kind: "directory" | "file";
  mode: number;
  bytes?: number;
  digest?: `sha256:${string}`;
}

export interface V1ProjectionSnapshotManifestV2 {
  manifest_version: 1;
  kind: "v1_projection_snapshot";
  created_at: string;
  source_v1_active: V1ActiveIdentityV2;
  roots: string[];
  entries: ProjectionSnapshotEntryV2[];
  entries_digest: `sha256:${string}`;
}

export interface V1AuditSegmentV2 {
  relative_path: string;
  bytes: number;
  rows: number;
  digest: `sha256:${string}`;
  terminal: boolean;
}

interface V1SealIntentV2 {
  manifest_version: 1;
  kind: "v1_seal_intent";
  created_at: string;
  active_identity: V1ActiveIdentityV2;
  terminal_archive: string;
  projection_snapshot_digest: `sha256:${string}`;
}

export interface V1SealManifestV2 {
  manifest_version: 1;
  kind: "v1_seal";
  sealed_at: string;
  terminal_archive: string;
  terminal_digest: `sha256:${string}`;
  terminal_bytes: number;
  terminal_rows: number;
  projection_snapshot_digest: `sha256:${string}`;
  segments: V1AuditSegmentV2[];
  audit_set_digest: `sha256:${string}`;
}

interface V1RollbackIntentV2 {
  manifest_version: 1;
  kind: "v1_rollback_intent";
  created_at: string;
  seal_manifest_digest: `sha256:${string}`;
  projection_snapshot_digest: `sha256:${string}`;
}

export interface V1RollbackRecordV2 {
  manifest_version: 1;
  kind: "v1_rollback_complete";
  completed_at: string;
  seal_manifest_digest: `sha256:${string}`;
  projection_snapshot_digest: `sha256:${string}`;
  continuation: V1ActiveIdentityV2;
}

export interface CreateProjectionSnapshotV2Input {
  coordRoot: string;
  artifactRoot: string;
  projectionPaths: readonly string[];
  now?: () => number;
  onStep?: (step: CutoverV2Step, relativePath?: string) => void;
}

export interface SealV1LedgerV2Input {
  coordRoot: string;
  artifactRoot: string;
  snapshot: V1ProjectionSnapshotManifestV2;
  now?: () => number;
  onStep?: (step: CutoverV2Step, relativePath?: string) => void;
}

export interface RollbackV1LedgerV2Input {
  coordRoot: string;
  artifactRoot: string;
  snapshot: V1ProjectionSnapshotManifestV2;
  seal: V1SealManifestV2;
  now?: () => number;
  onStep?: (step: CutoverV2Step, relativePath?: string) => void;
}

export interface CutoverRehearsalV2Result {
  ok: true;
  root: string;
  artifact_root: string;
  snapshot_digest: `sha256:${string}`;
  seal_digest: `sha256:${string}`;
  audit_set_digest: `sha256:${string}`;
  stale_writer_refused: true;
  rollback_digest: `sha256:${string}`;
}

/** Capture the inode identity an already-running V1 writer believes is active. */
export function captureV1ActiveIdentityV2(coordRoot: string): V1ActiveIdentityV2 {
  const path = join(resolve(coordRoot), V1_ACTIVE_RELATIVE_PATH);
  if (!existsSync(path)) throw new Error("v1_active_missing");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("v1_active_not_regular_file");
  const facts = inspectNdjsonFile(path);
  return {
    relative_path: V1_ACTIVE_RELATIVE_PATH,
    device: facts.device,
    inode: facts.inode,
    bytes: facts.bytes,
    digest: facts.digest,
  };
}

/**
 * Refuse a writer that was born against a different V1 active inode. The hard
 * directory fence remains authoritative even for old clients that do not call
 * this helper: opening it with append semantics fails with EISDIR.
 */
export function assertV1WriterIdentityV2(coordRoot: string, expected: V1ActiveIdentityV2): void {
  const path = join(resolve(coordRoot), V1_ACTIVE_RELATIVE_PATH);
  if (!existsSync(path)) throw new Error("v1_writer_fenced");
  const stat = lstatSync(path);
  if (stat.isDirectory()) throw new Error("v1_writer_fenced");
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("v1_writer_path_unsafe");
  if (String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode) {
    throw new Error("v1_writer_stale");
  }
}

/** Snapshot only explicitly named disposable .harnery projections. */
export function createProjectionSnapshotV2(
  input: CreateProjectionSnapshotV2Input,
): V1ProjectionSnapshotManifestV2 {
  const coordRoot = resolve(input.coordRoot);
  const artifactRoot = safeArtifactRoot(coordRoot, input.artifactRoot);
  const roots = [...new Set(input.projectionPaths.map(normalizeProjectionPath))].sort();
  if (roots.length === 0) throw new Error("projection_snapshot_requires_paths");
  for (const [index, root] of roots.entries()) {
    if (roots.some((candidate, other) => other !== index && root.startsWith(`${candidate}/`))) {
      throw new Error(`projection_snapshot_roots_overlap:${root}`);
    }
    const projectionRoot = resolveInside(coordRoot, root);
    if (inside(projectionRoot, artifactRoot) || inside(artifactRoot, projectionRoot)) {
      throw new Error(`projection_snapshot_artifact_overlap:${root}`);
    }
  }
  const existingManifest = readOptionalCanonicalJson<V1ProjectionSnapshotManifestV2>(
    join(artifactRoot, "snapshot", "manifest.json"),
  );
  if (existingManifest) {
    if (canonicalJsonV2(existingManifest.roots) !== canonicalJsonV2(roots)) {
      throw new Error("projection_snapshot_roots_conflict");
    }
    validateSnapshotObjects(coordRoot, artifactRoot, existingManifest);
    return existingManifest;
  }
  const entries = roots.flatMap((root) => collectProjectionEntries(coordRoot, root));
  entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const objects = join(artifactRoot, "snapshot", "objects");
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.digest) continue;
    const source = resolveInside(coordRoot, entry.relative_path);
    const object = join(objects, entry.digest.slice("sha256:".length));
    const bytes = readBoundedFile(source, OBJECT_LIMIT);
    if (sha256V2(bytes) !== entry.digest || bytes.byteLength !== entry.bytes) {
      throw new Error(`projection_changed_during_snapshot:${entry.relative_path}`);
    }
    writeImmutableObject(object, bytes);
  }
  const manifest: V1ProjectionSnapshotManifestV2 = {
    manifest_version: 1,
    kind: "v1_projection_snapshot",
    created_at: timestamp(input.now),
    source_v1_active: captureV1ActiveIdentityV2(coordRoot),
    roots,
    entries,
    entries_digest: sha256V2(canonicalJsonV2(entries)),
  };
  writeImmutableCanonicalJson(join(artifactRoot, "snapshot", "manifest.json"), manifest);
  input.onStep?.("snapshot_manifest_committed");
  return manifest;
}

export function readProjectionSnapshotV2(artifactRoot: string): V1ProjectionSnapshotManifestV2 {
  const manifest = readCanonicalJson<V1ProjectionSnapshotManifestV2>(
    join(resolve(artifactRoot), "snapshot", "manifest.json"),
  );
  validateProjectionSnapshotManifest(manifest);
  return manifest;
}

export function projectionSnapshotDigestV2(
  manifest: V1ProjectionSnapshotManifestV2,
): `sha256:${string}` {
  validateProjectionSnapshotManifest(manifest);
  return sha256V2(canonicalJsonV2(manifest));
}

/**
 * Rename V1's active file to a collision-safe archive and occupy the old path
 * with an immutable directory fence. Rerunning after a kill completes only the
 * exact precommitted intent; changed bytes are never blessed retroactively.
 */
export function sealV1LedgerV2(input: SealV1LedgerV2Input): V1SealManifestV2 {
  const coordRoot = resolve(input.coordRoot);
  const artifactRoot = safeArtifactRoot(coordRoot, input.artifactRoot);
  validateSnapshotObjects(coordRoot, artifactRoot, input.snapshot);
  const snapshotDigest = projectionSnapshotDigestV2(input.snapshot);
  const intentPath = join(artifactRoot, "v1-seal-intent.json");
  const existingIntent = readOptionalCanonicalJson<V1SealIntentV2>(intentPath);
  const intent =
    existingIntent ??
    buildSealIntent(coordRoot, input.snapshot.source_v1_active, snapshotDigest, input.now);
  validateSealIntent(intent, input.snapshot.source_v1_active, snapshotDigest);
  if (!existingIntent) {
    writeImmutableCanonicalJson(intentPath, intent);
    input.onStep?.("seal_intent_committed");
  }

  const activePath = join(coordRoot, V1_ACTIVE_RELATIVE_PATH);
  const archivePath = resolveInside(coordRoot, intent.terminal_archive);
  if (existsSync(activePath) && lstatSync(activePath).isFile()) {
    assertIdentityEquals(captureV1ActiveIdentityV2(coordRoot), intent.active_identity);
    if (existsSync(archivePath)) throw new Error("v1_terminal_archive_collision");
    renameSync(activePath, archivePath);
    fsyncParentDirectory(archivePath);
    input.onStep?.("v1_active_renamed", intent.terminal_archive);
  }
  assertTerminalArchive(archivePath, intent.active_identity);
  installV1Fence(activePath, intent);
  input.onStep?.("v1_fence_installed", V1_ACTIVE_RELATIVE_PATH);

  const segments = listV1AuditSegments(coordRoot, intent.terminal_archive);
  const terminal = segments.find((segment) => segment.terminal);
  if (!terminal) throw new Error("v1_terminal_archive_unlisted");
  const manifest: V1SealManifestV2 = {
    manifest_version: 1,
    kind: "v1_seal",
    sealed_at: timestamp(input.now),
    terminal_archive: terminal.relative_path,
    terminal_digest: terminal.digest,
    terminal_bytes: terminal.bytes,
    terminal_rows: terminal.rows,
    projection_snapshot_digest: snapshotDigest,
    segments,
    audit_set_digest: sha256V2(canonicalJsonV2(segments)),
  };
  const manifestPath = join(artifactRoot, "v1-seal.json");
  const existing = readOptionalCanonicalJson<V1SealManifestV2>(manifestPath);
  if (existing) {
    validateSealManifest(coordRoot, existing, snapshotDigest);
    return existing;
  }
  writeImmutableCanonicalJson(manifestPath, manifest);
  input.onStep?.("seal_manifest_committed");
  return manifest;
}

export function v1SealManifestDigestV2(manifest: V1SealManifestV2): `sha256:${string}` {
  validateSealManifestShape(manifest);
  return sha256V2(canonicalJsonV2(manifest));
}

export function readV1SealManifestV2(artifactRoot: string): V1SealManifestV2 {
  const manifest = readCanonicalJson<V1SealManifestV2>(join(resolve(artifactRoot), "v1-seal.json"));
  validateSealManifestShape(manifest);
  return manifest;
}

/** Verify every archived byte and the hard fence without changing state. */
export function verifyV1SealV2(
  coordRoot: string,
  seal: V1SealManifestV2,
  snapshotDigest: `sha256:${string}`,
): void {
  validateSealManifest(resolve(coordRoot), seal, snapshotDigest);
}

/**
 * Restore snapshot roots using one atomic rename per root. Replays are
 * idempotent. Displaced post-snapshot state is retained under the artifact root
 * instead of being deleted.
 */
export function restoreProjectionSnapshotV2(
  input: CreateProjectionSnapshotV2Input & { snapshot: V1ProjectionSnapshotManifestV2 },
): void {
  const coordRoot = resolve(input.coordRoot);
  const artifactRoot = safeArtifactRoot(coordRoot, input.artifactRoot);
  validateSnapshotObjects(coordRoot, artifactRoot, input.snapshot);
  const digest = projectionSnapshotDigestV2(input.snapshot).slice("sha256:".length);
  const stagingRoot = join(artifactRoot, `restore-${digest}`);
  materializeSnapshot(stagingRoot, artifactRoot, input.snapshot);
  for (const root of input.snapshot.roots) {
    const destination = resolveInside(coordRoot, root);
    if (projectionRootMatches(destination, root, input.snapshot)) {
      input.onStep?.("projection_root_restored", root);
      continue;
    }
    const staged = resolveInside(stagingRoot, root);
    const displaced = join(artifactRoot, "displaced", digest, root);
    if (existsSync(destination)) {
      if (existsSync(displaced)) throw new Error(`projection_displaced_collision:${root}`);
      mkdirSync(dirname(displaced), { recursive: true, mode: 0o700 });
      renameSync(destination, displaced);
      fsyncParentDirectory(displaced);
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    renameSync(staged, destination);
    fsyncParentDirectory(destination);
    input.onStep?.("projection_root_restored", root);
  }
}

/** Complete the exact recorded rollback; never move sealed V1 bytes back. */
export function rollbackV1LedgerV2(input: RollbackV1LedgerV2Input): V1RollbackRecordV2 {
  const coordRoot = resolve(input.coordRoot);
  const artifactRoot = safeArtifactRoot(coordRoot, input.artifactRoot);
  const snapshotDigest = projectionSnapshotDigestV2(input.snapshot);
  const sealDigest = v1SealManifestDigestV2(input.seal);
  validateSnapshotObjects(coordRoot, artifactRoot, input.snapshot);
  validateSealManifest(coordRoot, input.seal, snapshotDigest, false);
  const recordPath = join(artifactRoot, "v1-rollback-complete.json");
  const completed = readOptionalCanonicalJson<V1RollbackRecordV2>(recordPath);
  if (completed) {
    validateRollbackRecord(coordRoot, completed, sealDigest, snapshotDigest);
    for (const root of input.snapshot.roots) {
      const destination = resolveInside(coordRoot, root);
      if (!projectionRootMatches(destination, root, input.snapshot)) {
        throw new Error(`v1_rollback_projection_changed:${root}`);
      }
    }
    return completed;
  }
  const intent: V1RollbackIntentV2 = {
    manifest_version: 1,
    kind: "v1_rollback_intent",
    created_at: timestamp(input.now),
    seal_manifest_digest: sealDigest,
    projection_snapshot_digest: snapshotDigest,
  };
  const intentPath = join(artifactRoot, "v1-rollback-intent.json");
  const existingIntent = readOptionalCanonicalJson<V1RollbackIntentV2>(intentPath);
  if (existingIntent && canonicalJsonV2(existingIntent) !== canonicalJsonV2(intent)) {
    // A retry may occur at a different time, so compare only authority-bearing fields.
    if (
      existingIntent.kind !== intent.kind ||
      existingIntent.seal_manifest_digest !== sealDigest ||
      existingIntent.projection_snapshot_digest !== snapshotDigest
    ) {
      throw new Error("v1_rollback_intent_conflict");
    }
  } else if (!existingIntent) {
    writeImmutableCanonicalJson(intentPath, intent);
    input.onStep?.("rollback_intent_committed");
  }

  const activePath = join(coordRoot, V1_ACTIVE_RELATIVE_PATH);
  removeExactV1Fence(activePath, input.seal);
  input.onStep?.("v1_fence_removed", V1_ACTIVE_RELATIVE_PATH);
  if (!existsSync(activePath)) {
    const fd = openSync(activePath, "wx", 0o600);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncParentDirectory(activePath);
    input.onStep?.("v1_continuation_created", V1_ACTIVE_RELATIVE_PATH);
  } else {
    const stat = lstatSync(activePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("v1_continuation_path_unsafe");
    if (stat.size !== 0) throw new Error("v1_continuation_not_empty");
  }
  restoreProjectionSnapshotV2({
    coordRoot,
    artifactRoot,
    projectionPaths: input.snapshot.roots,
    snapshot: input.snapshot,
    onStep: input.onStep,
  });
  const record: V1RollbackRecordV2 = {
    manifest_version: 1,
    kind: "v1_rollback_complete",
    completed_at: timestamp(input.now),
    seal_manifest_digest: sealDigest,
    projection_snapshot_digest: snapshotDigest,
    continuation: captureV1ActiveIdentityV2(coordRoot),
  };
  writeImmutableCanonicalJson(recordPath, record);
  input.onStep?.("rollback_record_committed");
  return record;
}

/** End-to-end proof restricted to an explicit OS temporary root. */
export function rehearseCutoverV2(input: {
  root: string;
  projectionPaths: readonly string[];
  now?: () => number;
  onStep?: (step: CutoverV2Step, relativePath?: string) => void;
}): CutoverRehearsalV2Result {
  const root = assertTemporaryRehearsalRoot(input.root);
  const artifactRoot = join(root, ".harnery", "cutover-v2-rehearsal");
  const snapshot = createProjectionSnapshotV2({
    coordRoot: root,
    artifactRoot,
    projectionPaths: input.projectionPaths,
    now: input.now,
    onStep: input.onStep,
  });
  const staleIdentity = snapshot.source_v1_active;
  const seal = sealV1LedgerV2({
    coordRoot: root,
    artifactRoot,
    snapshot,
    now: input.now,
    onStep: input.onStep,
  });
  let staleWriterRefused = false;
  try {
    assertV1WriterIdentityV2(root, staleIdentity);
  } catch (error) {
    staleWriterRefused = (error as Error).message === "v1_writer_fenced";
  }
  if (!staleWriterRefused) throw new Error("stale_v1_writer_was_not_refused");
  const rollback = rollbackV1LedgerV2({
    coordRoot: root,
    artifactRoot,
    snapshot,
    seal,
    now: input.now,
    onStep: input.onStep,
  });
  try {
    assertV1WriterIdentityV2(root, staleIdentity);
    throw new Error("stale_v1_writer_rejoined_after_rollback");
  } catch (error) {
    if ((error as Error).message !== "v1_writer_stale") throw error;
  }
  return {
    ok: true,
    root,
    artifact_root: artifactRoot,
    snapshot_digest: projectionSnapshotDigestV2(snapshot),
    seal_digest: v1SealManifestDigestV2(seal),
    audit_set_digest: seal.audit_set_digest,
    stale_writer_refused: true,
    rollback_digest: sha256V2(canonicalJsonV2(rollback)),
  };
}

function buildSealIntent(
  coordRoot: string,
  active: V1ActiveIdentityV2,
  snapshotDigest: `sha256:${string}`,
  now?: () => number,
): V1SealIntentV2 {
  assertIdentityEquals(captureV1ActiveIdentityV2(coordRoot), active);
  const stat = statSync(join(coordRoot, V1_ACTIVE_RELATIVE_PATH));
  return {
    manifest_version: 1,
    kind: "v1_seal_intent",
    created_at: timestamp(now),
    active_identity: active,
    terminal_archive: nextArchiveRelativePath(coordRoot, stat.mtimeMs),
    projection_snapshot_digest: snapshotDigest,
  };
}

function validateSealIntent(
  intent: V1SealIntentV2,
  active: V1ActiveIdentityV2,
  snapshotDigest: `sha256:${string}`,
): void {
  if (
    intent.manifest_version !== 1 ||
    intent.kind !== "v1_seal_intent" ||
    intent.projection_snapshot_digest !== snapshotDigest ||
    canonicalJsonV2(intent.active_identity) !== canonicalJsonV2(active) ||
    !/^\.harnery\/events-[0-9]{4}-[0-9]{2}-[0-9]{2}(?:\.[1-9][0-9]*)?\.ndjson$/.test(
      intent.terminal_archive,
    )
  ) {
    throw new Error("v1_seal_intent_invalid");
  }
}

function installV1Fence(activePath: string, intent: V1SealIntentV2): void {
  if (existsSync(activePath)) {
    const stat = lstatSync(activePath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("v1_fence_path_unsafe");
  } else {
    mkdirSync(activePath, { mode: 0o700 });
    fsyncParentDirectory(activePath);
  }
  chmodSync(activePath, 0o700);
  writeImmutableCanonicalJson(join(activePath, V1_FENCE_MARKER), {
    manifest_version: 1,
    kind: "v1_hard_path_fence",
    terminal_archive: intent.terminal_archive,
    terminal_digest: intent.active_identity.digest,
  });
  chmodSync(activePath, 0o500);
  fsyncParentDirectory(activePath);
}

function validateExactV1Fence(activePath: string, seal: V1SealManifestV2): void {
  if (!existsSync(activePath)) throw new Error("v1_hard_fence_missing");
  const stat = lstatSync(activePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("v1_hard_fence_missing");
  const names = readdirSync(activePath).sort();
  if (names.length !== 1 || names[0] !== V1_FENCE_MARKER) throw new Error("v1_fence_not_exact");
  const marker = readCanonicalJson<Record<string, unknown>>(join(activePath, V1_FENCE_MARKER));
  if (
    marker.kind !== "v1_hard_path_fence" ||
    marker.terminal_archive !== seal.terminal_archive ||
    marker.terminal_digest !== seal.terminal_digest
  ) {
    throw new Error("v1_fence_marker_mismatch");
  }
}

function removeExactV1Fence(activePath: string, seal: V1SealManifestV2): void {
  if (!existsSync(activePath)) return;
  const stat = lstatSync(activePath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    if (stat.isFile() && stat.size === 0) return;
    throw new Error("v1_fence_path_unsafe");
  }
  validateExactV1Fence(activePath, seal);
  chmodSync(activePath, 0o700);
  unlinkSync(join(activePath, V1_FENCE_MARKER));
  rmdirSync(activePath);
  fsyncParentDirectory(activePath);
}

function listV1AuditSegments(coordRoot: string, terminalArchive: string): V1AuditSegmentV2[] {
  const harnery = join(coordRoot, ".harnery");
  return readdirSync(harnery)
    .filter((name) => /^events-.+\.ndjson$/.test(name))
    .sort()
    .map((name) => {
      const relativePath = `.harnery/${name}`;
      const path = join(harnery, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`v1_archive_unsafe:${name}`);
      const facts = inspectNdjsonFile(path);
      if (!facts.terminated) {
        throw new Error(`v1_archive_unterminated:${name}`);
      }
      return {
        relative_path: relativePath,
        bytes: facts.bytes,
        rows: facts.rows,
        digest: facts.digest,
        terminal: relativePath === terminalArchive,
      };
    });
}

function validateSealManifest(
  coordRoot: string,
  manifest: V1SealManifestV2,
  snapshotDigest: `sha256:${string}`,
  requireFence = true,
): void {
  validateSealManifestShape(manifest);
  if (manifest.projection_snapshot_digest !== snapshotDigest) {
    throw new Error("v1_seal_snapshot_mismatch");
  }
  const actual = listV1AuditSegments(coordRoot, manifest.terminal_archive);
  if (canonicalJsonV2(actual) !== canonicalJsonV2(manifest.segments)) {
    throw new Error("v1_sealed_audit_bytes_changed");
  }
  if (sha256V2(canonicalJsonV2(actual)) !== manifest.audit_set_digest) {
    throw new Error("v1_seal_audit_set_digest_mismatch");
  }
  const terminal = actual.find((segment) => segment.terminal);
  if (
    !terminal ||
    terminal.digest !== manifest.terminal_digest ||
    terminal.bytes !== manifest.terminal_bytes ||
    terminal.rows !== manifest.terminal_rows
  ) {
    throw new Error("v1_seal_terminal_mismatch");
  }
  if (requireFence) {
    const activePath = join(coordRoot, V1_ACTIVE_RELATIVE_PATH);
    validateExactV1Fence(activePath, manifest);
  }
}

function validateRollbackRecord(
  coordRoot: string,
  record: V1RollbackRecordV2,
  sealDigest: `sha256:${string}`,
  snapshotDigest: `sha256:${string}`,
): void {
  if (
    record.manifest_version !== 1 ||
    record.kind !== "v1_rollback_complete" ||
    record.seal_manifest_digest !== sealDigest ||
    record.projection_snapshot_digest !== snapshotDigest
  ) {
    throw new Error("v1_rollback_record_invalid");
  }
  const current = captureV1ActiveIdentityV2(coordRoot);
  if (canonicalJsonV2(current) !== canonicalJsonV2(record.continuation)) {
    throw new Error("v1_rollback_continuation_changed");
  }
}

function validateSealManifestShape(manifest: V1SealManifestV2): void {
  if (
    manifest.manifest_version !== 1 ||
    manifest.kind !== "v1_seal" ||
    !Array.isArray(manifest.segments) ||
    !manifest.terminal_archive ||
    !manifest.terminal_digest.startsWith("sha256:") ||
    !manifest.audit_set_digest.startsWith("sha256:")
  ) {
    throw new Error("v1_seal_manifest_invalid");
  }
}

function validateProjectionSnapshotManifest(manifest: V1ProjectionSnapshotManifestV2): void {
  if (
    manifest.manifest_version !== 1 ||
    manifest.kind !== "v1_projection_snapshot" ||
    !Array.isArray(manifest.roots) ||
    manifest.roots.length === 0 ||
    !Array.isArray(manifest.entries) ||
    sha256V2(canonicalJsonV2(manifest.entries)) !== manifest.entries_digest
  ) {
    throw new Error("projection_snapshot_manifest_invalid");
  }
  for (const root of manifest.roots) normalizeProjectionPath(root);
  for (const entry of manifest.entries) {
    normalizeProjectionPath(entry.relative_path);
    if (entry.kind === "file") {
      if (!entry.digest?.startsWith("sha256:") || !Number.isSafeInteger(entry.bytes)) {
        throw new Error("projection_snapshot_entry_invalid");
      }
    } else if (entry.kind !== "directory") {
      throw new Error("projection_snapshot_entry_invalid");
    }
  }
}

function validateSnapshotObjects(
  coordRoot: string,
  artifactRoot: string,
  manifest: V1ProjectionSnapshotManifestV2,
): void {
  validateProjectionSnapshotManifest(manifest);
  assertIdentityEquals(manifest.source_v1_active, manifest.source_v1_active);
  const objects = join(artifactRoot, "snapshot", "objects");
  for (const entry of manifest.entries) {
    resolveInside(coordRoot, entry.relative_path);
    if (entry.kind !== "file" || !entry.digest) continue;
    const object = join(objects, entry.digest.slice("sha256:".length));
    const bytes = readBoundedFile(object, OBJECT_LIMIT);
    if (sha256V2(bytes) !== entry.digest || bytes.byteLength !== entry.bytes) {
      throw new Error(`projection_snapshot_object_mismatch:${entry.relative_path}`);
    }
  }
}

function materializeSnapshot(
  stagingRoot: string,
  artifactRoot: string,
  manifest: V1ProjectionSnapshotManifestV2,
): void {
  for (const entry of manifest.entries.filter((candidate) => candidate.kind === "directory")) {
    const path = resolveInside(stagingRoot, entry.relative_path);
    mkdirSync(path, { recursive: true, mode: entry.mode });
    chmodSync(path, entry.mode);
    fsyncParentDirectory(path);
  }
  for (const entry of manifest.entries.filter((candidate) => candidate.kind === "file")) {
    if (!entry.digest) throw new Error("projection_snapshot_file_digest_missing");
    const destination = resolveInside(stagingRoot, entry.relative_path);
    if (existsSync(destination)) {
      const bytes = readBoundedFile(destination, OBJECT_LIMIT);
      if (sha256V2(bytes) !== entry.digest || bytes.byteLength !== entry.bytes) {
        throw new Error(`projection_restore_staging_mismatch:${entry.relative_path}`);
      }
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(
      join(artifactRoot, "snapshot", "objects", entry.digest.slice("sha256:".length)),
      destination,
    );
    chmodSync(destination, entry.mode);
    const fd = openSync(destination, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncParentDirectory(destination);
  }
}

function projectionRootMatches(
  destination: string,
  root: string,
  manifest: V1ProjectionSnapshotManifestV2,
): boolean {
  if (!existsSync(destination)) return false;
  const expected = manifest.entries.filter(
    (entry) => entry.relative_path === root || entry.relative_path.startsWith(`${root}/`),
  );
  try {
    const actual = collectProjectionEntries(dirnameForRelativeRoot(destination, root), root);
    return canonicalJsonV2(actual) === canonicalJsonV2(expected);
  } catch {
    return false;
  }
}

function dirnameForRelativeRoot(destination: string, root: string): string {
  let current = destination;
  for (const _component of root.split("/")) current = dirname(current);
  return current;
}

function collectProjectionEntries(
  coordRoot: string,
  relativePath: string,
): ProjectionSnapshotEntryV2[] {
  const path = resolveInside(coordRoot, relativePath);
  if (!existsSync(path)) throw new Error(`projection_path_missing:${relativePath}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`projection_symlink_forbidden:${relativePath}`);
  const mode = stat.mode & 0o777;
  if (stat.isFile()) {
    const bytes = readBoundedFile(path, OBJECT_LIMIT);
    return [
      {
        relative_path: relativePath,
        kind: "file",
        mode,
        bytes: bytes.byteLength,
        digest: sha256V2(bytes),
      },
    ];
  }
  if (!stat.isDirectory()) throw new Error(`projection_path_type_unsupported:${relativePath}`);
  const entries: ProjectionSnapshotEntryV2[] = [
    { relative_path: relativePath, kind: "directory", mode },
  ];
  for (const name of readdirSync(path).sort()) {
    entries.push(...collectProjectionEntries(coordRoot, `${relativePath}/${name}`));
  }
  return entries;
}

function normalizeProjectionPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (
    !normalized.startsWith(".harnery/") ||
    normalized.includes("//") ||
    normalized.split("/").includes("..") ||
    normalized === V1_ACTIVE_RELATIVE_PATH ||
    /^\.harnery\/events-.+\.ndjson$/.test(normalized) ||
    normalized.startsWith(`${EVENT_V2_LEDGER_RELATIVE_ROOT}/`) ||
    normalized === EVENT_V2_LEDGER_RELATIVE_ROOT ||
    normalized.startsWith(".harnery/cutover-v2-rehearsal/")
  ) {
    throw new Error(`projection_path_forbidden:${value}`);
  }
  return normalized;
}

function safeArtifactRoot(coordRoot: string, value: string): string {
  const artifactRoot = resolve(value);
  const liveV2 = resolve(coordRoot, EVENT_V2_LEDGER_RELATIVE_ROOT);
  if (inside(liveV2, artifactRoot)) throw new Error("live_v2_artifact_path_forbidden");
  return artifactRoot;
}

function assertTemporaryRehearsalRoot(value: string): string {
  const root = resolve(value);
  const temporary = resolve(tmpdir());
  if (!inside(temporary, root) || root === temporary) {
    throw new Error("cutover_rehearsal_requires_explicit_temporary_root");
  }
  const stat = existsSync(root) ? lstatSync(root) : undefined;
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("cutover_rehearsal_root_invalid");
  }
  return root;
}

function nextArchiveRelativePath(coordRoot: string, mtimeMs: number): string {
  const date = new Date(mtimeMs).toISOString().slice(0, 10);
  const harnery = join(coordRoot, ".harnery");
  for (let suffix = 0; ; suffix += 1) {
    const name = `events-${date}${suffix === 0 ? "" : `.${suffix}`}.ndjson`;
    if (!existsSync(join(harnery, name))) return `.harnery/${name}`;
  }
}

function assertTerminalArchive(path: string, identity: V1ActiveIdentityV2): void {
  if (!existsSync(path)) throw new Error("v1_terminal_archive_missing");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("v1_terminal_archive_unsafe");
  const facts = inspectNdjsonFile(path);
  if (facts.bytes !== identity.bytes || facts.digest !== identity.digest) {
    throw new Error("v1_terminal_archive_changed");
  }
}

function assertIdentityEquals(actual: V1ActiveIdentityV2, expected: V1ActiveIdentityV2): void {
  if (canonicalJsonV2(actual) !== canonicalJsonV2(expected)) {
    throw new Error("v1_active_changed_since_snapshot");
  }
}

function timestamp(now?: () => number): string {
  return new Date((now ?? Date.now)()).toISOString();
}

function inspectNdjsonFile(path: string): {
  device: string;
  inode: string;
  bytes: number;
  rows: number;
  digest: `sha256:${string}`;
  terminated: boolean;
} {
  const beforePath = lstatSync(path);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error(`v1_segment_unsafe:${basename(path)}`);
  }
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let rows = 0;
  let bytes = 0;
  let lastByte: number | undefined;
  try {
    const before = fstatSync(fd);
    if (before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error(`v1_segment_replaced_during_open:${basename(path)}`);
    }
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      const slice = chunk.subarray(0, read);
      hash.update(slice);
      bytes += read;
      lastByte = slice.at(-1);
      for (const byte of slice) if (byte === 0x0a) rows += 1;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== after.size) {
      throw new Error(`v1_segment_changed_during_hash:${basename(path)}`);
    }
    return {
      device: String(after.dev),
      inode: String(after.ino),
      bytes,
      rows,
      digest: `sha256:${hash.digest("hex")}`,
      terminated: bytes === 0 || lastByte === 0x0a,
    };
  } finally {
    closeSync(fd);
  }
}

function resolveInside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error(`absolute_path_forbidden:${relativePath}`);
  const candidate = resolve(root, relativePath);
  if (!inside(resolve(root), candidate) || candidate === resolve(root)) {
    throw new Error(`path_outside_root:${relativePath}`);
  }
  return candidate;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function readBoundedFile(path: string, limit: number): Buffer {
  if (!existsSync(path)) throw new Error(`cutover_file_missing:${basename(path)}`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`cutover_file_unsafe:${basename(path)}`);
  if (stat.size > limit) throw new Error(`cutover_file_too_large:${basename(path)}`);
  return readFileSync(path);
}

function writeImmutableObject(path: string, bytes: Uint8Array): void {
  if (existsSync(path)) {
    if (!Buffer.from(readFileSync(path)).equals(Buffer.from(bytes))) {
      throw new Error("snapshot_object_digest_collision");
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temporary, path);
      fsyncParentDirectory(path);
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!Buffer.from(readFileSync(path)).equals(Buffer.from(bytes))) {
        throw new Error("snapshot_object_digest_collision");
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function writeImmutableCanonicalJson(path: string, value: unknown): void {
  const body = `${canonicalJsonV2(value)}\n`;
  if (Buffer.byteLength(body) > MANIFEST_LIMIT) throw new Error("cutover_manifest_too_large");
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== body)
      throw new Error(`immutable_cutover_record_conflict:${path}`);
    return;
  }
  writeImmutableObject(path, Buffer.from(body, "utf8"));
}

function readCanonicalJson<T>(path: string): T {
  const body = readBoundedFile(path, MANIFEST_LIMIT).toString("utf8");
  const parsed = JSON.parse(body) as T;
  if (`${canonicalJsonV2(parsed)}\n` !== body)
    throw new Error(`cutover_record_not_canonical:${path}`);
  return parsed;
}

function readOptionalCanonicalJson<T>(path: string): T | undefined {
  return existsSync(path) ? readCanonicalJson<T>(path) : undefined;
}
