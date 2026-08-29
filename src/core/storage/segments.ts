import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { HarneryRegisteredStorageFamily } from "./contract.ts";
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
  next_sequence: number;
  segments: readonly HarneryLogSegmentV1[];
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
}

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
      mkdirSync(this.#options.directory, { recursive: true, mode: 0o700 });
      const active = join(this.#options.directory, "active.jsonl");
      let rotated = false;
      if (existsSync(active) && shouldRotate(active, records, this.#options, now)) {
        sealActive(active, this.#options.family, now);
        rotated = true;
      }
      const fd = openSync(active, "a", 0o600);
      let bytes = 0;
      try {
        for (const record of records) bytes += writeSync(fd, record);
        if (durable) fdatasyncSync(fd);
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
  const value = JSON.parse(readFileSync(path, "utf8")) as HarneryLogManifestV1;
  if (value.schema !== "harnery.log-manifest/v1" || !Array.isArray(value.segments)) {
    throw new Error(`invalid log manifest: ${path}`);
  }
  if (
    family &&
    (value.family_id !== family.id || value.policy_version !== family.policy.policy_version)
  ) {
    throw new Error(`log manifest identity mismatch: ${path}`);
  }
  if (
    !Number.isSafeInteger(value.next_sequence) ||
    value.next_sequence < 1 ||
    value.segments.some(
      (segment, index) =>
        segment.sequence !== index + 1 ||
        !/^segments\/[0-9]{8}-[0-9]{8}\.jsonl\.gz$/.test(segment.file) ||
        !/^[a-f0-9]{64}$/.test(segment.sha256),
    ) ||
    value.next_sequence !== value.segments.length + 1
  ) {
    throw new Error(`invalid log manifest sequence: ${path}`);
  }
  return value;
}

export async function withFamilyLease<T>(
  directory: string,
  policy: { lease_timeout_ms: number; lease_retry_ms: number; lease_stale_ms: number },
  operation: () => Promise<T> | T,
): Promise<T> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lease = join(directory, ".append-lease");
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lease, { mode: 0o700 });
      writeFileSync(
        join(lease, "owner.json"),
        `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      break;
    } catch (error) {
      if (existsSync(lease) && !statSync(lease).isDirectory()) {
        throw new HarneryLogLeaseError("wrong_type", `log lease is not a directory: ${lease}`);
      }
      if (leaseIsStale(lease, policy.lease_stale_ms)) {
        rmSync(lease, { recursive: true, force: true });
        continue;
      }
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
    rmSync(lease, { recursive: true, force: true });
  }
}

function shouldRotate(
  active: string,
  incoming: readonly Buffer[],
  options: ResolvedSegmentOptions,
  now: Date,
): boolean {
  const stat = statSync(active);
  const incomingBytes = incoming.reduce((sum, record) => sum + record.byteLength, 0);
  if (stat.size + incomingBytes > options.max_segment_bytes) return stat.size > 0;
  const age = now.getTime() - stat.mtimeMs;
  if (age >= options.max_open_age_ms) return stat.size > 0;
  const opened = new Date(stat.mtimeMs);
  return (
    opened.toDateString() !== now.toDateString() && stat.size >= options.minimum_day_segment_bytes
  );
}

function sealActive(active: string, family: HarneryRegisteredStorageFamily, now: Date): void {
  const directory = dirname(active);
  const manifest = readSegmentManifest(directory, family);
  const content = readFileSync(active);
  if (content.byteLength === 0) return;
  const sequence = manifest.next_sequence;
  const name = `${now.toISOString().slice(0, 10).replaceAll("-", "")}-${String(sequence).padStart(8, "0")}.jsonl.gz`;
  const target = join(directory, "segments", name);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const compressed = gzipSync(content);
  writeFileSync(temporary, compressed, { mode: 0o600 });
  renameSync(temporary, target);
  const lines = content.toString("utf8").trimEnd().split("\n").filter(Boolean);
  const timestamps = lines
    .map((line) => {
      try {
        return (JSON.parse(line) as { emitted_at?: string }).emitted_at;
      } catch {
        return undefined;
      }
    })
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
  writeFileSync(sealedManifest, `${JSON.stringify(next)}\n`, { flag: "wx", mode: 0o600 });
  atomicJson(join(directory, "manifest.json"), next);
  writeFileSync(active, "", { mode: 0o600 });
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

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function leaseIsStale(lease: string, maximumAgeMs: number): boolean {
  try {
    const owner = JSON.parse(readFileSync(join(lease, "owner.json"), "utf8")) as {
      pid?: number;
      acquired_at?: string;
    };
    if (!Number.isSafeInteger(owner.pid) || !owner.acquired_at) return false;
    if (Date.now() - Date.parse(owner.acquired_at) < maximumAgeMs) return false;
    try {
      process.kill(owner.pid!, 0);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}
