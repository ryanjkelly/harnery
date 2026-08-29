import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

export const HARNERY_DURABLE_HISTORY_SCHEMA = "harnery.durable-history/v1" as const;

export interface DurableHistoryOptions {
  max_record_bytes: number;
  max_segment_bytes: number;
  fault?: (boundary: DurableHistoryFaultBoundary) => void;
  /** Fault-injection seam; production callers use the default syscall. */
  write_sync?: DurableHistoryWriteSync;
}

export type DurableHistoryWriteSync = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
) => number;

export type DurableHistoryFaultBoundary =
  | "after_segment_rename"
  | "before_append"
  | "after_append_before_sync"
  | "after_rewrite_temp_sync"
  | "after_rewrite_publish";

export interface DurableHistoryAppendReceipt {
  schema: typeof HARNERY_DURABLE_HISTORY_SCHEMA;
  segment: "active";
  record_bytes: number;
  rotated: boolean;
  synced: true;
}

export interface DurableHistoryReadOptions {
  max_record_bytes: number;
  max_records?: number;
}

export interface CrashSafeJsonlUpdate<R> {
  append?: readonly unknown[];
  result: R;
}

export function appendDurableHistoryRecord(
  objectDir: string,
  record: unknown,
  options: DurableHistoryOptions,
): DurableHistoryAppendReceipt {
  validateOptions(options);
  const line = encodeRecord(record, options.max_record_bytes);
  ensurePrivateDirectory(objectDir);
  return withLease(join(objectDir, ".append.lease"), () => {
    const active = join(objectDir, "active.jsonl");
    let rotated = false;
    const activeBytes = regularFileBytes(active);
    if (activeBytes > 0 && activeBytes + Buffer.byteLength(line) > options.max_segment_bytes) {
      const segments = join(objectDir, "segments");
      const segmentDirectory = ensurePrivateDirectory(segments);
      validateJsonlBeforeSeal(active, options.max_record_bytes);
      const target = join(segments, nextSegmentName(segments));
      rejectExistingSymlink(target);
      renameSync(active, target);
      assertRegularPath(target, segmentDirectory);
      syncDirectory(captureDirectoryIdentity(objectDir));
      syncDirectory(segmentDirectory);
      options.fault?.("after_segment_rename");
      rotated = true;
    }
    options.fault?.("before_append");
    appendAndSync(active, line, options.fault, options.write_sync);
    return {
      schema: HARNERY_DURABLE_HISTORY_SCHEMA,
      segment: "active",
      record_bytes: Buffer.byteLength(line),
      rotated,
      synced: true,
    };
  });
}

export function appendCrashSafeJsonlFile(
  path: string,
  record: unknown,
  maxRecordBytes: number,
  fault?: DurableHistoryOptions["fault"],
): number {
  const line = encodeRecord(record, maxRecordBytes);
  ensurePrivateDirectory(dirname(path));
  return withLease(`${path}.lease`, () => {
    fault?.("before_append");
    appendAndSync(path, line, fault);
    return Buffer.byteLength(line);
  });
}

export function appendSegmentedJsonlFile(
  activePath: string,
  record: unknown,
  options: DurableHistoryOptions,
): DurableHistoryAppendReceipt {
  validateOptions(options);
  const line = encodeRecord(record, options.max_record_bytes);
  ensurePrivateDirectory(dirname(activePath));
  return withLease(`${activePath}.segment.lease`, () => {
    let rotated = false;
    const activeBytes = regularFileBytes(activePath);
    if (activeBytes > 0 && activeBytes + Buffer.byteLength(line) > options.max_segment_bytes) {
      const segments = `${activePath}.segments`;
      const segmentDirectory = ensurePrivateDirectory(segments);
      validateJsonlBeforeSeal(activePath, options.max_record_bytes);
      const target = join(segments, nextSegmentName(segments));
      rejectExistingSymlink(target);
      renameSync(activePath, target);
      assertRegularPath(target, segmentDirectory);
      syncDirectory(captureDirectoryIdentity(dirname(activePath)));
      syncDirectory(segmentDirectory);
      options.fault?.("after_segment_rename");
      rotated = true;
    }
    options.fault?.("before_append");
    appendAndSync(activePath, line, options.fault, options.write_sync);
    return {
      schema: HARNERY_DURABLE_HISTORY_SCHEMA,
      segment: "active",
      record_bytes: Buffer.byteLength(line),
      rotated,
      synced: true,
    };
  });
}

export function updateCrashSafeJsonlFile<T, R>(
  path: string,
  options: DurableHistoryReadOptions,
  update: (records: readonly T[]) => CrashSafeJsonlUpdate<R>,
  fault?: DurableHistoryOptions["fault"],
): R {
  ensurePrivateDirectory(dirname(path));
  return withLease(`${path}.lease`, () => {
    const records = readCrashSafeJsonlFile<T>(path, options);
    const decision = update(records);
    if (decision.append && decision.append.length > 0) {
      const body = decision.append
        .map((record) => encodeRecord(record, options.max_record_bytes))
        .join("");
      fault?.("before_append");
      appendAndSync(path, body, fault);
    }
    return decision.result;
  });
}

export async function* streamDurableHistory<T>(
  objectDir: string,
  options: DurableHistoryReadOptions,
): AsyncGenerator<T> {
  let count = 0;
  for (const path of durableHistoryPaths(objectDir)) {
    for await (const line of boundedJsonlLines(path, options.max_record_bytes)) {
      if (line.length === 0) continue;
      count += 1;
      if (options.max_records !== undefined && count > options.max_records) {
        throw new Error(`durable history exceeds ${options.max_records} records`);
      }
      yield parseRecord<T>(line, basename(path), count);
    }
  }
}

export function readDurableHistorySync<T>(
  objectDir: string,
  options: DurableHistoryReadOptions,
): T[] {
  const records: T[] = [];
  for (const path of durableHistoryPaths(objectDir)) {
    const content = completeJsonl(path);
    for (const line of content.split("\n")) {
      if (!line) continue;
      if (Buffer.byteLength(line) + 1 > options.max_record_bytes) {
        throw new Error(`durable history record exceeds ${options.max_record_bytes} bytes`);
      }
      records.push(parseRecord<T>(line, basename(path), records.length + 1));
      if (options.max_records !== undefined && records.length > options.max_records) {
        throw new Error(`durable history exceeds ${options.max_records} records`);
      }
    }
  }
  return records;
}

export function readCrashSafeJsonlFile<T>(path: string, options: DurableHistoryReadOptions): T[] {
  if (!existsSync(path)) return [];
  rejectSymlink(path);
  const content = completeJsonl(path);
  const records: T[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    if (Buffer.byteLength(line) + 1 > options.max_record_bytes) {
      throw new Error(`durable history record exceeds ${options.max_record_bytes} bytes`);
    }
    records.push(parseRecord<T>(line, basename(path), records.length + 1));
    if (options.max_records !== undefined && records.length > options.max_records) {
      throw new Error(`durable history exceeds ${options.max_records} records`);
    }
  }
  return records;
}

export function readSegmentedJsonlFileSync<T>(
  activePath: string,
  options: DurableHistoryReadOptions,
): T[] {
  const records: T[] = [];
  const segments = `${activePath}.segments`;
  const paths = existsSync(segments)
    ? readdirSync(segments)
        .filter((name) => /^\d{8}\.jsonl$/.test(name))
        .sort()
        .map((name) => join(segments, name))
    : [];
  if (existsSync(activePath)) paths.push(activePath);
  for (const path of paths) {
    rejectSymlink(path);
    for (const line of completeJsonl(path).split("\n")) {
      if (!line) continue;
      if (Buffer.byteLength(line) + 1 > options.max_record_bytes) {
        throw new Error(`durable history record exceeds ${options.max_record_bytes} bytes`);
      }
      records.push(parseRecord<T>(line, basename(path), records.length + 1));
      if (options.max_records !== undefined && records.length > options.max_records) {
        throw new Error(`durable history exceeds ${options.max_records} records`);
      }
    }
  }
  return records;
}

export async function rewriteCrashSafeJsonlFile(
  path: string,
  records: readonly unknown[],
  maxRecordBytes: number,
  fault?: DurableHistoryOptions["fault"],
): Promise<void> {
  const body = records.map((record) => encodeRecord(record, maxRecordBytes)).join("");
  const parent = ensurePrivateDirectory(dirname(path));
  rejectExistingSymlink(path);
  const temp = `${path}.rewrite-${process.pid}`;
  await withLeaseAsync(`${path}.lease`, async () => {
    const handle = await open(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
      0o600,
    );
    try {
      await writeAll(handle, Buffer.from(body, "utf8"));
      await handle.sync();
      assertOpenFileIdentity(temp, handle.fd, parent);
    } finally {
      await handle.close();
    }
    fault?.("after_rewrite_temp_sync");
    assertDirectoryIdentity(parent);
    rejectExistingSymlink(path);
    await rename(temp, path);
    assertRegularPath(path, parent);
    syncDirectory(parent);
    fault?.("after_rewrite_publish");
  });
  await rm(temp, { force: true });
}

export function durableHistoryPaths(objectDir: string): string[] {
  if (!existsSync(objectDir)) return [];
  rejectSymlink(objectDir);
  const paths: string[] = [];
  const segments = join(objectDir, "segments");
  if (existsSync(segments)) {
    captureDirectoryIdentity(segments);
    rejectSymlink(segments);
    for (const name of readdirSync(segments).sort()) {
      if (!/^\d{8}\.jsonl$/.test(name)) continue;
      const path = join(segments, name);
      rejectSymlink(path);
      paths.push(path);
    }
  }
  const active = join(objectDir, "active.jsonl");
  if (existsSync(active)) {
    rejectSymlink(active);
    paths.push(active);
  }
  return paths;
}

function appendAndSync(
  path: string,
  line: string,
  fault: DurableHistoryOptions["fault"] | undefined,
  writer: DurableHistoryWriteSync = nativeWriteSync,
): void {
  const parent = captureDirectoryIdentity(dirname(path));
  rejectExistingSymlink(path);
  const fd = openSync(
    path,
    fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollowFlag(),
    0o600,
  );
  try {
    assertOpenFileIdentity(path, fd, parent);
    assertCompleteTail(fd, path);
    writeAllSync(fd, Buffer.from(line, "utf8"), writer);
    fault?.("after_append_before_sync");
    fsyncSync(fd);
    assertOpenFileIdentity(path, fd, parent);
    syncDirectory(parent);
  } finally {
    closeSync(fd);
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

function regularFileBytes(path: string): number {
  if (!existsSync(path)) return 0;
  rejectSymlink(path);
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error(`durable history path is not a regular file: ${path}`);
  return stats.size;
}

function rejectSymlink(path: string): void {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`durable history rejects symlink: ${path}`);
}

function completeJsonl(path: string): string {
  const parent = captureDirectoryIdentity(dirname(path));
  rejectExistingSymlink(path);
  const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  let content: string;
  try {
    assertOpenFileIdentity(path, fd, parent);
    content = readFileSync(fd, "utf8");
    assertOpenFileIdentity(path, fd, parent);
  } finally {
    closeSync(fd);
  }
  if (content && !content.endsWith("\n")) {
    throw new Error(`durable history has a partial record: ${basename(path)}`);
  }
  return content;
}

function validateJsonlBeforeSeal(path: string, maximumRecordBytes: number): void {
  const content = completeJsonl(path);
  const lines = content.split("\n");
  lines.pop();
  for (const [index, line] of lines.entries()) {
    if (!line) throw new Error(`durable history has malformed JSONL in ${basename(path)}`);
    if (Buffer.byteLength(line) + 1 > maximumRecordBytes) {
      throw new Error(`durable history record exceeds ${maximumRecordBytes} bytes`);
    }
    parseRecord(line, basename(path), index + 1);
  }
}

async function* boundedJsonlLines(
  path: string,
  maximumRecordBytes: number,
): AsyncGenerator<string> {
  const parent = captureDirectoryIdentity(dirname(path));
  rejectExistingSymlink(path);
  const fd = openSync(path, fsConstants.O_RDONLY | noFollowFlag());
  let position = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  try {
    assertOpenFileIdentity(path, fd, parent);
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumRecordBytes + 1));
      const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, position);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, bytesRead);
      let start = 0;
      for (let index = 0; index < view.byteLength; index += 1) {
        if (view[index] !== 10) continue;
        const part = view.subarray(start, index);
        const lineBytes = pendingBytes + part.byteLength + 1;
        if (lineBytes > maximumRecordBytes) {
          throw new Error(`durable history record exceeds ${maximumRecordBytes} bytes`);
        }
        if (part.byteLength > 0) pending.push(part);
        yield Buffer.concat(pending, pendingBytes + part.byteLength).toString("utf8");
        pending = [];
        pendingBytes = 0;
        start = index + 1;
      }
      const tail = view.subarray(start);
      if (pendingBytes + tail.byteLength >= maximumRecordBytes) {
        throw new Error(`durable history record exceeds ${maximumRecordBytes} bytes`);
      }
      if (tail.byteLength > 0) {
        pending.push(tail);
        pendingBytes += tail.byteLength;
      }
      position += bytesRead;
    }
    if (pendingBytes > 0) {
      throw new Error(`durable history has a partial record: ${basename(path)}`);
    }
    assertOpenFileIdentity(path, fd, parent);
  } finally {
    closeSync(fd);
  }
}

function nextSegmentName(segments: string): string {
  const last = readdirSync(segments)
    .filter((name) => /^\d{8}\.jsonl$/.test(name))
    .sort()
    .at(-1);
  const next = last ? Number.parseInt(last.slice(0, 8), 10) + 1 : 1;
  return `${String(next).padStart(8, "0")}.jsonl`;
}

function encodeRecord(record: unknown, maxRecordBytes: number): string {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 1) {
    throw new Error("max_record_bytes must be a positive safe integer");
  }
  const line = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > maxRecordBytes)
    throw new Error(`durable history record exceeds ${maxRecordBytes} bytes`);
  return line;
}

function parseRecord<T>(line: string, file: string, index: number): T {
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    throw new Error(
      `invalid durable history JSON in ${file} record ${index}: ${(error as Error).message}`,
    );
  }
}

function validateOptions(options: DurableHistoryOptions): void {
  if (
    !Number.isSafeInteger(options.max_record_bytes) ||
    options.max_record_bytes <= 1 ||
    !Number.isSafeInteger(options.max_segment_bytes) ||
    options.max_segment_bytes < options.max_record_bytes
  ) {
    throw new Error("max_segment_bytes must be a safe integer at least max_record_bytes");
  }
}

function withLease<T>(lease: string, action: () => T): T {
  const owner = acquireLease(lease);
  try {
    return action();
  } finally {
    releaseOwnedLease(lease, owner);
  }
}

async function withLeaseAsync<T>(lease: string, action: () => Promise<T>): Promise<T> {
  const owner = acquireLease(lease);
  try {
    return await action();
  } finally {
    releaseOwnedLease(lease, owner);
  }
}

const DURABLE_HISTORY_LEASE_STALE_MS = 30_000;

interface LeaseOwner {
  owner_id: string;
  pid: number;
  acquired_at: string;
}

function acquireLease(lease: string): LeaseOwner {
  const parent = captureDirectoryIdentity(dirname(lease));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner: LeaseOwner = {
      owner_id: randomUUID(),
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    };
    let claimed: DirectoryIdentity | undefined;
    try {
      mkdirSync(lease, { mode: 0o700 });
      assertDirectoryWithinParent(lease, parent);
      claimed = captureDirectoryIdentity(lease);
      writeOwner(join(lease, "owner.json"), owner);
      syncDirectory(claimed);
      return owner;
    } catch {
      if (claimed) {
        try {
          assertDirectoryIdentity(claimed);
          rmSync(lease, { recursive: true, force: false });
        } catch {
          // Never remove a lease after its directory identity changes.
        }
      }
      if (recoverStaleLease(lease, DURABLE_HISTORY_LEASE_STALE_MS)) continue;
      throw new Error(`durable history lease busy: ${lease}`);
    }
  }
  throw new Error(`durable history lease busy: ${lease}`);
}

function writeOwner(path: string, owner: LeaseOwner): void {
  const parent = captureDirectoryIdentity(dirname(path));
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag(),
    0o600,
  );
  try {
    assertOpenFileIdentity(path, fd, parent);
    writeAllSync(fd, Buffer.from(`${JSON.stringify(owner)}\n`, "utf8"), nativeWriteSync);
    fsyncSync(fd);
    assertOpenFileIdentity(path, fd, parent);
  } finally {
    closeSync(fd);
  }
}

function recoverStaleLease(lease: string, staleMs: number): boolean {
  let leaseIdentity: DirectoryIdentity;
  try {
    leaseIdentity = captureDirectoryIdentity(lease);
  } catch {
    return false;
  }
  const ownerPath = join(lease, "owner.json");
  let raw: string;
  try {
    raw = completeJsonl(ownerPath);
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
    Date.now() - Date.parse(owner.acquired_at) < staleMs ||
    processIsAlive(owner.pid)
  ) {
    return false;
  }
  try {
    assertDirectoryIdentity(leaseIdentity);
    if (completeJsonl(ownerPath) !== raw) return false;
    rmSync(lease, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function releaseOwnedLease(lease: string, owner: LeaseOwner): void {
  try {
    const current = JSON.parse(completeJsonl(join(lease, "owner.json"))) as LeaseOwner;
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

function nativeWriteSync(fd: number, buffer: Buffer, offset: number, length: number): number {
  return writeSync(fd, buffer, offset, length);
}

function assertCompleteTail(fd: number, path: string): void {
  const stat = fstatSync(fd);
  if (stat.size === 0) return;
  const tail = Buffer.allocUnsafe(1);
  if (readSync(fd, tail, 0, 1, stat.size - 1) !== 1 || tail[0] !== 10) {
    throw new Error(`durable history has a partial record: ${basename(path)}`);
  }
}

function writeAllSync(fd: number, buffer: Buffer, writer: DurableHistoryWriteSync): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = writer(fd, buffer, offset, buffer.byteLength - offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > buffer.byteLength - offset) {
      throw new Error("durable history write made no forward progress");
    }
    offset += written;
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("durable history write made no forward progress");
    offset += bytesWritten;
  }
}

function noFollowFlag(): number {
  return fsConstants.O_NOFOLLOW ?? 0;
}

function rejectExistingSymlink(path: string): void {
  try {
    rejectSymlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function captureDirectoryIdentity(path: string): DirectoryIdentity {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`durable history rejects symlink: ${path}`);
  if (!stats.isDirectory()) throw new Error(`durable history path is not a directory: ${path}`);
  return { path, real_path: realpathSync(path), dev: stats.dev, ino: stats.ino };
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
    throw new Error(`durable history directory identity changed: ${identity.path}`);
  }
}

function assertDirectoryWithinParent(path: string, parent: DirectoryIdentity): void {
  assertDirectoryIdentity(parent);
  const child = captureDirectoryIdentity(path);
  const fromParent = relative(parent.real_path, child.real_path);
  if (fromParent.startsWith("..") || isAbsolute(fromParent)) {
    throw new Error(`durable history path escapes parent boundary: ${path}`);
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
    throw new Error(`durable history path identity changed: ${path}`);
  }
  const resolved = realpathSync(path);
  const fromParent = relative(parent.real_path, resolved);
  if (fromParent.startsWith("..") || isAbsolute(fromParent)) {
    throw new Error(`durable history path escapes parent boundary: ${path}`);
  }
}

function syncDirectory(identity: DirectoryIdentity): void {
  assertDirectoryIdentity(identity);
  const fd = openSync(identity.path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } catch (error) {
    if (!new Set(["EINVAL", "ENOTSUP", "EPERM"]).has((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}
