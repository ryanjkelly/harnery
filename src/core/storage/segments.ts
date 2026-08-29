import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import type { HarneryRegisteredStorageFamily } from "./contract.ts";
import { parseLogRecord } from "./jsonl.ts";
import type { HarneryLogMetricsDelta } from "./metrics.ts";
import { mergeMetricsSidecar } from "./metrics.ts";

export interface HarneryLogSegmentV1 {
  sequence: number;
  file: string;
  bytes: number;
  records: number;
  first_emitted_at?: string;
  last_emitted_at?: string;
  sealed_at: string;
  sha256: string;
}

export interface HarneryLogManifestV1 {
  schema: "harnery.log-manifest/v1";
  family_id: string;
  policy_version: string;
  /** Highest lifetime sequence intentionally expired by retention. */
  pruned_through_sequence?: number;
  next_sequence: number;
  segments: readonly HarneryLogSegmentV1[];
}

export interface PruneSealedLogSegmentOptions {
  directory: string;
  family: HarneryRegisteredStorageFamily;
  sequence: number;
  file: string;
  expected_bytes: number;
  /** Digest of the compressed file at the exact target path. */
  expected_file_sha256: string;
  /** Digest of the uncompressed JSONL recorded by the manifest. */
  expected_content_sha256: string;
  /** Semantic fingerprint of the exact manifest state frozen at planning. */
  expected_manifest_fingerprint: string;
  /** Semantic fingerprint of the reduced manifest committed by this action. */
  result_manifest_fingerprint: string;
  lease_timeout_ms?: number;
  lease_retry_ms?: number;
  lease_stale_ms?: number;
  /** Fault-injection seam after the manifest commit and before unlink. */
  after_manifest_commit?: () => void;
}

export interface SegmentAppendOptions {
  directory: string;
  family: HarneryRegisteredStorageFamily;
  max_segment_bytes?: number;
  max_open_age_ms?: number;
  minimum_day_segment_bytes?: number;
  lease_timeout_ms?: number;
  lease_retry_ms?: number;
  lease_stale_ms?: number;
  /** Fault-injection seam; production callers use the default syscall. */
  write_sync?: SegmentWriteSync;
}

export type SegmentWriteSync = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
) => number;

export interface SegmentAppendResult {
  appended_records: number;
  appended_bytes: number;
  rotated: boolean;
  synced: boolean;
}

interface ResolvedSegmentOptions {
  directory: string;
  family: HarneryRegisteredStorageFamily;
  max_segment_bytes: number;
  max_open_age_ms: number;
  minimum_day_segment_bytes: number;
  lease_timeout_ms: number;
  lease_retry_ms: number;
  lease_stale_ms: number;
  write_sync: SegmentWriteSync;
}

export class HarneryLogLeaseError extends Error {
  constructor(
    readonly reason: "timeout" | "wrong_type" | "invalid_owner",
    message: string,
  ) {
    super(message);
    this.name = "HarneryLogLeaseError";
  }
}

export function familyLogDirectory(family: HarneryRegisteredStorageFamily): string {
  const root = family.resolved_roots.find(
    (candidate) => candidate.match === "provider-partition" && candidate.ownership !== "external",
  );
  if (!root?.partition) throw new Error(`family ${family.id} has no writable log partition`);
  return join(root.path, root.partition);
}

export class FileSegmentSink {
  readonly #options: ResolvedSegmentOptions;

  constructor(options: SegmentAppendOptions) {
    this.#options = {
      ...options,
      max_segment_bytes:
        options.max_segment_bytes ??
        options.family.policy.rotation.max_segment_bytes.limit ??
        10 * 1024 * 1024,
      max_open_age_ms:
        options.max_open_age_ms ?? options.family.policy.rotation.max_open_age.limit ?? 86_400_000,
      minimum_day_segment_bytes: options.minimum_day_segment_bytes ?? 256 * 1024,
      lease_timeout_ms:
        options.lease_timeout_ms ?? options.family.lease_policy?.acquisition_timeout_ms ?? 2_000,
      lease_retry_ms: options.lease_retry_ms ?? options.family.lease_policy?.retry_backoff_ms ?? 10,
      lease_stale_ms:
        options.lease_stale_ms ?? options.family.lease_policy?.stale_owner_ms ?? 30_000,
      write_sync: options.write_sync ?? nativeWriteSync,
    };
  }

  async append(
    records: readonly Buffer[],
    metrics: HarneryLogMetricsDelta = {},
    durable = false,
    now = new Date(),
  ): Promise<SegmentAppendResult> {
    if (records.length === 0)
      return { appended_records: 0, appended_bytes: 0, rotated: false, synced: false };
    return withFamilyLease(this.#options.directory, this.#options, async () => {
      const directory = ensurePrivateDirectory(this.#options.directory);
      const active = join(this.#options.directory, "active.jsonl");
      let rotated = false;
      if (existsSync(active) && shouldRotate(active, records, this.#options, now)) {
        sealActive(active, this.#options, now);
        rotated = true;
      }
      rejectExistingSymlink(active);
      const fd = openSync(
        active,
        fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollowFlag(),
        0o600,
      );
      let bytes = 0;
      try {
        assertOpenFileIdentity(active, fd, directory);
        assertCompleteTail(fd, active);
        for (const record of records) {
          writeAllSync(fd, record, this.#options.write_sync);
          bytes += record.byteLength;
        }
        if (durable) fdatasyncSync(fd);
        assertOpenFileIdentity(active, fd, directory);
      } finally {
        closeSync(fd);
      }
      mergeMetricsSidecar(
        join(this.#options.directory, "metrics.json"),
        {
          ...metrics,
          appended: (metrics.appended ?? 0) + records.length,
          bytes_appended: (metrics.bytes_appended ?? 0) + bytes,
          rotations: (metrics.rotations ?? 0) + (rotated ? 1 : 0),
          synced: (metrics.synced ?? 0) + (durable ? records.length : 0),
        },
        now,
      );
      return { appended_records: records.length, appended_bytes: bytes, rotated, synced: durable };
    });
  }
}

export function readSegmentManifest(
  directory: string,
  family?: HarneryRegisteredStorageFamily,
): HarneryLogManifestV1 {
  const path = join(directory, "manifest.json");
  if (!existsSync(path)) {
    if (!family) throw new Error(`missing log manifest: ${path}`);
    return emptyManifest(family);
  }
  const value = JSON.parse(
    readRegularFile(path, 4 * 1024 * 1024).toString("utf8"),
  ) as HarneryLogManifestV1;
  if (value.schema !== "harnery.log-manifest/v1" || !Array.isArray(value.segments)) {
    throw new Error(`invalid log manifest: ${path}`);
  }
  if (
    family &&
    (value.family_id !== family.id || value.policy_version !== family.policy.policy_version)
  ) {
    throw new Error(`log manifest identity mismatch: ${path}`);
  }
  const prunedThrough = value.pruned_through_sequence ?? 0;
  if (
    !Number.isSafeInteger(prunedThrough) ||
    prunedThrough < 0 ||
    !Number.isSafeInteger(value.next_sequence) ||
    value.next_sequence < 1 ||
    prunedThrough >= value.next_sequence ||
    value.segments.some(
      (segment, index) =>
        segment.sequence !== prunedThrough + index + 1 ||
        !/^segments\/[0-9]{8}-[0-9]{8}\.jsonl\.gz$/.test(segment.file) ||
        !Number.isSafeInteger(segment.bytes) ||
        segment.bytes <= 0 ||
        !Number.isFinite(Date.parse(segment.sealed_at)) ||
        (index > 0 &&
          Date.parse(segment.sealed_at) < Date.parse(value.segments[index - 1]!.sealed_at)) ||
        !/^[a-f0-9]{64}$/.test(segment.sha256),
    ) ||
    value.next_sequence !== prunedThrough + value.segments.length + 1
  ) {
    throw new Error(`invalid log manifest sequence: ${path}`);
  }
  return value;
}

export function logManifestFingerprint(manifest: HarneryLogManifestV1): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

/**
 * Expire exactly the oldest retained segment. The manifest is authoritative,
 * so it commits before unlink. Replays cover all four crash states without
 * ever accepting an absent source from an old manifest.
 */
export async function pruneSealedLogSegment(
  options: PruneSealedLogSegmentOptions,
): Promise<"applied" | "already_applied"> {
  if (!Number.isSafeInteger(options.sequence) || options.sequence < 1) {
    throw new Error("invalid log retention sequence");
  }
  if (!/^segments\/[0-9]{8}-[0-9]{8}\.jsonl\.gz$/.test(options.file)) {
    throw new Error("invalid log retention segment path");
  }
  if (!Number.isSafeInteger(options.expected_bytes) || options.expected_bytes <= 0) {
    throw new Error("invalid log retention segment bytes");
  }
  if (
    !/^[a-f0-9]{64}$/.test(options.expected_file_sha256) ||
    !/^[a-f0-9]{64}$/.test(options.expected_content_sha256) ||
    !/^[a-f0-9]{64}$/.test(options.expected_manifest_fingerprint) ||
    !/^[a-f0-9]{64}$/.test(options.result_manifest_fingerprint)
  ) {
    throw new Error("invalid log retention segment digest");
  }
  const policy = {
    lease_timeout_ms:
      options.lease_timeout_ms ?? options.family.lease_policy?.acquisition_timeout_ms ?? 2_000,
    lease_retry_ms: options.lease_retry_ms ?? options.family.lease_policy?.retry_backoff_ms ?? 10,
    lease_stale_ms: options.lease_stale_ms ?? options.family.lease_policy?.stale_owner_ms ?? 30_000,
  };
  return withFamilyLease(options.directory, policy, () => {
    const manifest = readSegmentManifest(options.directory, options.family);
    const currentManifestFingerprint = logManifestFingerprint(manifest);
    const prunedThrough = manifest.pruned_through_sequence ?? 0;
    const target = containedSegmentPath(options.directory, options.file);
    if (options.sequence <= prunedThrough) {
      if (currentManifestFingerprint !== options.result_manifest_fingerprint) {
        throw new Error("log retention manifest changed after the planned prune");
      }
      if (!pathExists(target)) return "already_applied";
      assertExactSegment(target, options.expected_bytes, options.expected_file_sha256);
      unlinkSync(target);
      return "applied";
    }
    if (options.sequence !== prunedThrough + 1) {
      throw new Error("log retention segment is not the oldest retained sequence");
    }
    if (currentManifestFingerprint !== options.expected_manifest_fingerprint) {
      throw new Error("log retention manifest changed after planning");
    }
    const entry = manifest.segments[0];
    if (
      !entry ||
      entry.sequence !== options.sequence ||
      entry.file !== options.file ||
      entry.sha256 !== options.expected_content_sha256
    ) {
      throw new Error("log retention segment does not match the current manifest");
    }
    if (!pathExists(target)) {
      throw new Error("log retention source is absent while the manifest still references it");
    }
    assertExactSegment(target, options.expected_bytes, options.expected_file_sha256);
    const next: HarneryLogManifestV1 = {
      ...manifest,
      pruned_through_sequence: options.sequence,
      segments: manifest.segments.slice(1),
    };
    if (logManifestFingerprint(next) !== options.result_manifest_fingerprint) {
      throw new Error("log retention predicted manifest does not match apply state");
    }
    atomicJson(join(options.directory, "manifest.json"), next);
    options.after_manifest_commit?.();
    assertExactSegment(target, options.expected_bytes, options.expected_file_sha256);
    unlinkSync(target);
    return "applied";
  });
}

export async function withFamilyLease<T>(
  directory: string,
  policy: { lease_timeout_ms: number; lease_retry_ms: number; lease_stale_ms: number },
  operation: () => Promise<T> | T,
): Promise<T> {
  ensurePrivateDirectory(directory);
  const lease = join(directory, ".append-lease");
  const started = Date.now();
  let owner: LeaseOwner | undefined;
  while (true) {
    try {
      mkdirSync(lease, { mode: 0o700 });
      const leaseIdentity = captureDirectoryIdentity(lease);
      owner = {
        owner_id: randomUUID(),
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      };
      writeNewFile(join(lease, "owner.json"), Buffer.from(`${JSON.stringify(owner)}\n`));
      assertDirectoryIdentity(leaseIdentity);
      break;
    } catch (error) {
      if (pathExists(lease) && !safeLeaseDirectory(lease)) {
        throw new HarneryLogLeaseError("wrong_type", `log lease is not a directory: ${lease}`);
      }
      if (recoverStaleLease(lease, policy.lease_stale_ms)) continue;
      if (Date.now() - started >= policy.lease_timeout_ms) {
        throw new HarneryLogLeaseError("timeout", `timed out acquiring log lease: ${lease}`);
      }
      await new Promise((resolve) => setTimeout(resolve, policy.lease_retry_ms));
      void error;
    }
  }
  try {
    return await operation();
  } finally {
    if (owner) releaseOwnedLease(lease, owner);
  }
}

function shouldRotate(
  active: string,
  incoming: readonly Buffer[],
  options: ResolvedSegmentOptions,
  now: Date,
): boolean {
  const stat = regularFileStat(active);
  const incomingBytes = incoming.reduce((sum, record) => sum + record.byteLength, 0);
  if (stat.size + incomingBytes > options.max_segment_bytes) return stat.size > 0;
  const age = now.getTime() - stat.mtimeMs;
  if (age >= options.max_open_age_ms) return stat.size > 0;
  const opened = new Date(stat.mtimeMs);
  return (
    opened.toDateString() !== now.toDateString() && stat.size >= options.minimum_day_segment_bytes
  );
}

function sealActive(active: string, options: ResolvedSegmentOptions, now: Date): void {
  const family = options.family;
  const directory = dirname(active);
  const manifest = readSegmentManifest(directory, family);
  const maximumActiveBytes = Math.max(
    options.max_segment_bytes,
    family.policy.records.max_record_bytes.limit ?? 1024 * 1024,
  );
  const content = readRegularFile(active, maximumActiveBytes);
  if (content.byteLength === 0) return;
  const lines = validateCompleteLogJsonl(content, active, family);
  const sequence = manifest.next_sequence;
  const name = `${now.toISOString().slice(0, 10).replaceAll("-", "")}-${String(sequence).padStart(8, "0")}.jsonl.gz`;
  const target = join(directory, "segments", name);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const compressed = gzipSync(content);
  writeNewFile(temporary, compressed);
  rejectExistingSymlink(target);
  renameSync(temporary, target);
  assertRegularPath(target, captureDirectoryIdentity(dirname(target)));
  const timestamps = lines
    .map((record) => record.emitted_at)
    .filter((value): value is string => Boolean(value));
  const next: HarneryLogManifestV1 = {
    ...manifest,
    next_sequence: sequence + 1,
    segments: [
      ...manifest.segments,
      {
        sequence,
        file: join("segments", basename(target)).replaceAll("\\", "/"),
        bytes: content.byteLength,
        records: lines.length,
        ...(timestamps[0] ? { first_emitted_at: timestamps[0] } : {}),
        ...(timestamps.at(-1) ? { last_emitted_at: timestamps.at(-1) } : {}),
        sealed_at: now.toISOString(),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  };
  const sealedManifest = join(directory, "manifests", `${String(sequence).padStart(8, "0")}.json`);
  mkdirSync(dirname(sealedManifest), { recursive: true, mode: 0o700 });
  writeNewFile(sealedManifest, Buffer.from(`${JSON.stringify(next)}\n`));
  atomicJson(join(directory, "manifest.json"), next);
  truncateRegularFile(active);
}

function emptyManifest(family: HarneryRegisteredStorageFamily): HarneryLogManifestV1 {
  return {
    schema: "harnery.log-manifest/v1",
    family_id: family.id,
    policy_version: family.policy.policy_version,
    next_sequence: 1,
    segments: [],
  };
}

function containedSegmentPath(directory: string, relativePath: string): string {
  const path = join(directory, ...relativePath.split("/"));
  const parent = captureDirectoryIdentity(dirname(path));
  const fromRoot = relative(realpathSync(directory), parent.real_path);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("log retention segment escapes its family directory");
  }
  return path;
}

function assertExactSegment(path: string, expectedBytes: number, expectedSha256: string): void {
  const stat = regularFileStat(path);
  if (stat.nlink !== 1) throw new Error(`log retention rejects hard-linked segment: ${path}`);
  if (stat.size !== expectedBytes) throw new Error(`log retention segment size changed: ${path}`);
  const bytes = readRegularFile(path, expectedBytes);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error(`log retention segment digest changed: ${path}`);
  }
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeNewFile(temporary, Buffer.from(`${JSON.stringify(value)}\n`));
  rejectExistingSymlink(path);
  renameSync(temporary, path);
  assertRegularPath(path, captureDirectoryIdentity(dirname(path)));
}

interface LeaseOwner {
  owner_id: string;
  pid: number;
  acquired_at: string;
}

function recoverStaleLease(lease: string, maximumAgeMs: number): boolean {
  let identity: DirectoryIdentity;
  let raw: string;
  try {
    identity = captureDirectoryIdentity(lease);
    raw = readRegularFile(join(lease, "owner.json"), 4_096).toString("utf8");
  } catch {
    return false;
  }
  let owner: LeaseOwner;
  try {
    owner = JSON.parse(raw) as LeaseOwner;
  } catch {
    return false;
  }
  if (
    typeof owner.owner_id !== "string" ||
    owner.owner_id.length === 0 ||
    !Number.isSafeInteger(owner.pid) ||
    !Number.isFinite(Date.parse(owner.acquired_at)) ||
    Date.now() - Date.parse(owner.acquired_at) < maximumAgeMs ||
    processIsAlive(owner.pid)
  ) {
    return false;
  }
  try {
    assertDirectoryIdentity(identity);
    if (readRegularFile(join(lease, "owner.json"), 4_096).toString("utf8") !== raw) return false;
    rmSync(lease, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function releaseOwnedLease(lease: string, owner: LeaseOwner): void {
  try {
    const current = JSON.parse(
      readRegularFile(join(lease, "owner.json"), 4_096).toString("utf8"),
    ) as LeaseOwner;
    if (current.owner_id !== owner.owner_id) return;
    rmSync(lease, { recursive: true, force: false });
  } catch {
    // A missing or replaced lease does not belong to this operation.
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface DirectoryIdentity {
  path: string;
  real_path: string;
  dev: number;
  ino: number;
}

function ensurePrivateDirectory(path: string): DirectoryIdentity {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return captureDirectoryIdentity(path);
}

function captureDirectoryIdentity(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`log storage rejects symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`log storage path is not a directory: ${path}`);
  return { path, real_path: realpathSync(path), dev: stat.dev, ino: stat.ino };
}

function assertDirectoryIdentity(identity: DirectoryIdentity): void {
  const current = lstatSync(identity.path);
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    realpathSync(identity.path) !== identity.real_path
  ) {
    throw new Error(`log storage directory identity changed: ${identity.path}`);
  }
}

function rejectExistingSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`log storage rejects symlink: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertOpenFileIdentity(path: string, fd: number, parent: DirectoryIdentity): void {
  assertDirectoryIdentity(parent);
  const opened = fstatSync(fd);
  const current = lstatSync(path);
  if (
    !opened.isFile() ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  ) {
    throw new Error(`log storage path identity changed: ${path}`);
  }
  const fromParent = relative(parent.real_path, realpathSync(path));
  if (fromParent.startsWith("..") || isAbsolute(fromParent)) {
    throw new Error(`log storage path escapes parent boundary: ${path}`);
  }
}

function assertRegularPath(path: string, parent: DirectoryIdentity): void {
  const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    assertOpenFileIdentity(path, fd, parent);
  } finally {
    closeSync(fd);
  }
}

function regularFileStat(path: string) {
  const parent = captureDirectoryIdentity(dirname(path));
  rejectExistingSymlink(path);
  const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    assertOpenFileIdentity(path, fd, parent);
    return fstatSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readRegularFile(path: string, maximumBytes: number): Buffer {
  const parent = captureDirectoryIdentity(dirname(path));
  rejectExistingSymlink(path);
  const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    assertOpenFileIdentity(path, fd, parent);
    const stat = fstatSync(fd);
    if (stat.size > maximumBytes) throw new Error(`log storage file exceeds bound: ${path}`);
    const content = readFileSync(fd);
    assertOpenFileIdentity(path, fd, parent);
    return content;
  } finally {
    closeSync(fd);
  }
}

function writeNewFile(path: string, content: Buffer): void {
  const parent = captureDirectoryIdentity(dirname(path));
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
    0o600,
  );
  try {
    assertOpenFileIdentity(path, fd, parent);
    writeAllSync(fd, content, nativeWriteSync);
    fsyncSync(fd);
    assertOpenFileIdentity(path, fd, parent);
  } finally {
    closeSync(fd);
  }
}

function truncateRegularFile(path: string): void {
  const parent = captureDirectoryIdentity(dirname(path));
  rejectExistingSymlink(path);
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_TRUNC | noFollowFlag());
  try {
    fdatasyncSync(fd);
    assertOpenFileIdentity(path, fd, parent);
  } finally {
    closeSync(fd);
  }
}

function assertCompleteTail(fd: number, path: string): void {
  const stat = fstatSync(fd);
  if (stat.size === 0) return;
  const last = Buffer.allocUnsafe(1);
  if (readSync(fd, last, 0, 1, stat.size - 1) !== 1 || last[0] !== 10) {
    throw new Error(`log storage has a partial JSONL record: ${path}`);
  }
}

function validateCompleteLogJsonl(
  content: Buffer,
  path: string,
  family: HarneryRegisteredStorageFamily,
) {
  if (content.at(-1) !== 10) throw new Error(`log storage has a partial JSONL record: ${path}`);
  const rawLines = content.toString("utf8").split("\n");
  rawLines.pop();
  return rawLines.map((line) => {
    if (!line) throw new Error(`log storage has a malformed JSONL record: ${path}`);
    const record = parseLogRecord(line);
    if (record.family_id !== family.id || record.policy_version !== family.policy.policy_version) {
      throw new Error(`log storage record identity mismatch: ${path}`);
    }
    return record;
  });
}

function writeAllSync(fd: number, buffer: Buffer, writer: SegmentWriteSync): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writer(fd, buffer, offset, buffer.byteLength - offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > buffer.byteLength - offset) {
      throw new Error("log storage write made no forward progress");
    }
    offset += written;
  }
}

function nativeWriteSync(fd: number, buffer: Buffer, offset: number, length: number): number {
  return writeSync(fd, buffer, offset, length);
}

function safeLeaseDirectory(path: string): boolean {
  try {
    return !lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}
