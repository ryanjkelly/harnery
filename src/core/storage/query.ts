import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { HarneryLogLevel, HarneryRegisteredStorageFamily } from "./contract.ts";
import type { HarneryLogRecordV1 } from "./jsonl.ts";
import { parseLogRecord } from "./jsonl.ts";
import { familyLogDirectory, readSegmentManifest } from "./segments.ts";

export interface HarneryLogQuery {
  family_ids?: readonly string[];
  minimum_level?: HarneryLogLevel;
  event?: string;
  since?: string;
  until?: string;
  context?: Readonly<Record<string, string | number | boolean | null>>;
  max_records: number;
  max_bytes: number;
}

export interface HarneryLogQueryResult {
  records: readonly HarneryLogRecordV1[];
  records_examined: number;
  bytes_examined: number;
  truncated: boolean;
  /** Per-family highest sequence intentionally expired by retention. */
  expired_through: Readonly<Record<string, number>>;
}

export interface HarneryLogFollowCursor {
  family_id: string;
  manifest_sequence: number;
  active_offset: number;
}

const LEVELS: readonly HarneryLogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];
const MAX_UNBOUNDED_RECORD_BYTES = 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;

export async function queryLogs(
  families: readonly HarneryRegisteredStorageFamily[],
  query: HarneryLogQuery,
): Promise<HarneryLogQueryResult> {
  if (
    !Number.isSafeInteger(query.max_records) ||
    query.max_records <= 0 ||
    !Number.isSafeInteger(query.max_bytes) ||
    query.max_bytes <= 0
  )
    throw new Error("log query requires positive global budgets");
  const records: HarneryLogRecordV1[] = [];
  let bytes = 0;
  let examined = 0;
  let truncated = false;
  const expiredThrough: Record<string, number> = {};
  for (const family of families) {
    if (query.family_ids && !query.family_ids.includes(family.id)) continue;
    const directory = familyLogDirectory(family);
    const manifest = readSegmentManifest(directory, family);
    expiredThrough[family.id] = manifest.pruned_through_sequence ?? 0;
    const sources = manifestSources(directory, manifest);
    const maximumLineBytes =
      family.policy.records.max_record_bytes.limit ?? MAX_UNBOUNDED_RECORD_BYTES;
    for (const source of sources) {
      for await (const line of linesFrom(source.path, source.gzip, maximumLineBytes)) {
        const lineBytes = Buffer.byteLength(line) + 1;
        if (bytes + lineBytes > query.max_bytes || examined >= query.max_records) {
          truncated = true;
          break;
        }
        bytes += lineBytes;
        examined += 1;
        if (!line.trim()) continue;
        const record = parseLogRecord(line);
        if (matches(record, query)) records.push(record);
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return {
    records,
    records_examined: examined,
    bytes_examined: bytes,
    truncated,
    expired_through: expiredThrough,
  };
}

export function rotationFollowCursor(
  family: HarneryRegisteredStorageFamily,
): HarneryLogFollowCursor {
  const directory = familyLogDirectory(family);
  const manifest = readSegmentManifest(directory, family);
  const active = join(directory, "active.jsonl");
  return {
    family_id: family.id,
    manifest_sequence: manifest.next_sequence - 1,
    active_offset: existsSync(active) ? regularFileStat(active).size : 0,
  };
}

export async function readLogFollow(
  family: HarneryRegisteredStorageFamily,
  cursor: HarneryLogFollowCursor,
  maxBytes: number,
): Promise<{
  records: readonly HarneryLogRecordV1[];
  cursor: HarneryLogFollowCursor;
  rotated: boolean;
  history_expired: boolean;
}> {
  if (cursor.family_id !== family.id) throw new Error("follow cursor family mismatch");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("follow requires a positive byte budget");
  }
  const directory = familyLogDirectory(family);
  const manifest = readSegmentManifest(directory, family);
  const rotated = manifest.next_sequence - 1 > cursor.manifest_sequence;
  const prunedThrough = manifest.pruned_through_sequence ?? 0;
  const historyExpired = prunedThrough > 0 && cursor.manifest_sequence <= prunedThrough;
  const active = join(directory, "active.jsonl");
  if (!existsSync(active)) {
    return {
      records: [],
      cursor: rotationFollowCursor(family),
      rotated,
      history_expired: historyExpired,
    };
  }
  const opened = openRegularNoFollow(active);
  const maximumLineBytes =
    family.policy.records.max_record_bytes.limit ?? MAX_UNBOUNDED_RECORD_BYTES;
  const records: HarneryLogRecordV1[] = [];
  let offset: number;
  let consumed = 0;
  try {
    const size = fstatSync(opened.fd).size;
    offset = rotated || cursor.active_offset > size ? 0 : cursor.active_offset;
    let position = offset;
    let remainingBudget = Math.min(maxBytes, size - offset);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    while (remainingBudget > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, remainingBudget));
      const bytesRead = readSync(opened.fd, chunk, 0, chunk.byteLength, position);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, bytesRead);
      let start = 0;
      for (let index = 0; index < view.byteLength; index += 1) {
        if (view[index] !== 10) continue;
        const part = view.subarray(start, index);
        assertLineBound(active, pendingBytes + part.byteLength + 1, maximumLineBytes);
        if (part.byteLength > 0) pending.push(part);
        const line = Buffer.concat(pending, pendingBytes + part.byteLength).toString("utf8");
        if (line) records.push(parseLogRecord(line));
        consumed = position + index + 1 - offset;
        pending = [];
        pendingBytes = 0;
        start = index + 1;
      }
      const tail = view.subarray(start);
      assertLineBound(active, pendingBytes + tail.byteLength, maximumLineBytes);
      if (tail.byteLength > 0) {
        pending.push(tail);
        pendingBytes += tail.byteLength;
      }
      position += bytesRead;
      remainingBudget -= bytesRead;
    }
    assertOpenFileIdentity(active, opened.fd, opened.parent);
  } finally {
    closeSync(opened.fd);
  }
  return {
    records,
    cursor: {
      family_id: family.id,
      manifest_sequence: manifest.next_sequence - 1,
      active_offset: offset + consumed,
    },
    rotated,
    history_expired: historyExpired,
  };
}

function manifestSources(
  directory: string,
  manifest: ReturnType<typeof readSegmentManifest>,
): Array<{ path: string; gzip: boolean }> {
  const sealed = manifest.segments.map((segment) => ({
    path: join(directory, segment.file),
    gzip: true,
  }));
  const active = join(directory, "active.jsonl");
  return existsSync(active) ? [...sealed, { path: active, gzip: false }] : sealed;
}

async function* linesFrom(
  path: string,
  gzip: boolean,
  maximumLineBytes: number,
): AsyncGenerator<string> {
  const opened = openRegularNoFollow(path);
  const input = Readable.from(descriptorChunks(opened.fd));
  const stream = gzip
    ? input.pipe(
        createGunzip({
          chunkSize: Math.max(64, Math.min(STREAM_CHUNK_BYTES, maximumLineBytes + 1)),
        }),
      )
    : input;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      let start = 0;
      for (let index = 0; index < chunk.byteLength; index += 1) {
        if (chunk[index] !== 10) continue;
        const part = chunk.subarray(start, index);
        assertLineBound(path, pendingBytes + part.byteLength + 1, maximumLineBytes);
        if (part.byteLength > 0) pending.push(part);
        yield Buffer.concat(pending, pendingBytes + part.byteLength).toString("utf8");
        pending = [];
        pendingBytes = 0;
        start = index + 1;
      }
      const tail = chunk.subarray(start);
      assertLineBound(path, pendingBytes + tail.byteLength, maximumLineBytes);
      if (tail.byteLength > 0) {
        pending.push(tail);
        pendingBytes += tail.byteLength;
      }
    }
    if (pendingBytes > 0) throw new Error(`log query has a partial JSONL record: ${path}`);
  } finally {
    assertOpenFileIdentity(path, opened.fd, opened.parent);
    stream.destroy();
    input.destroy();
    closeOwnedDescriptor(opened.fd);
  }
}

function matches(record: HarneryLogRecordV1, query: HarneryLogQuery): boolean {
  if (query.minimum_level && LEVELS.indexOf(record.level) < LEVELS.indexOf(query.minimum_level))
    return false;
  if (query.event && record.event !== query.event) return false;
  if (query.since && record.emitted_at < query.since) return false;
  if (query.until && record.emitted_at > query.until) return false;
  return Object.entries(query.context ?? {}).every(([key, value]) => record.context[key] === value);
}

interface DirectoryIdentity {
  path: string;
  real_path: string;
  dev: number;
  ino: number;
}

function captureDirectoryIdentity(path: string): DirectoryIdentity {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`log query rejects symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`log query path is not a directory: ${path}`);
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
    throw new Error(`log query directory identity changed: ${identity.path}`);
  }
}

function openRegularNoFollow(path: string): { fd: number; parent: DirectoryIdentity } {
  const parent = captureDirectoryIdentity(dirname(path));
  rejectSymlink(path);
  const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  try {
    assertOpenFileIdentity(path, fd, parent);
    return { fd, parent };
  } catch (error) {
    closeSync(fd);
    throw error;
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
    throw new Error(`log query path identity changed: ${path}`);
  }
  const fromParent = relative(parent.real_path, realpathSync(path));
  if (fromParent.startsWith("..") || isAbsolute(fromParent)) {
    throw new Error(`log query path escapes parent boundary: ${path}`);
  }
}

function regularFileStat(path: string) {
  const opened = openRegularNoFollow(path);
  try {
    return fstatSync(opened.fd);
  } finally {
    closeSync(opened.fd);
  }
}

function rejectSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`log query rejects symlink: ${path}`);
}

function assertLineBound(path: string, bytes: number, maximum: number): void {
  if (bytes > maximum) throw new Error(`log query record exceeds ${maximum} bytes: ${path}`);
}

function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}

function closeOwnedDescriptor(fd: number): void {
  try {
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
  }
}

async function* descriptorChunks(fd: number): AsyncGenerator<Buffer> {
  let position = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    yield chunk.subarray(0, bytesRead);
  }
}
