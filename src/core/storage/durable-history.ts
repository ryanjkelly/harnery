import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

export const HARNERY_DURABLE_HISTORY_SCHEMA = "harnery.durable-history/v1" as const;

export interface DurableHistoryOptions {
  max_record_bytes: number;
  max_segment_bytes: number;
  fault?: (boundary: DurableHistoryFaultBoundary) => void;
}

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
      ensurePrivateDirectory(segments);
      renameSync(active, join(segments, nextSegmentName(segments)));
      options.fault?.("after_segment_rename");
      rotated = true;
    }
    options.fault?.("before_append");
    appendAndSync(active, line, options.fault);
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
      ensurePrivateDirectory(segments);
      renameSync(activePath, join(segments, nextSegmentName(segments)));
      options.fault?.("after_segment_rename");
      rotated = true;
    }
    options.fault?.("before_append");
    appendAndSync(activePath, line, options.fault);
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
    const input = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      if (line.length === 0) continue;
      const bytes = Buffer.byteLength(line) + 1;
      if (bytes > options.max_record_bytes) {
        throw new Error(`durable history record exceeds ${options.max_record_bytes} bytes`);
      }
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.rewrite-${process.pid}`;
  await withLeaseAsync(`${path}.lease`, async () => {
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    fault?.("after_rewrite_temp_sync");
    await rename(temp, path);
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
): void {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line, undefined, "utf8");
    fault?.("after_append_before_sync");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
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
  const content = readFileSync(path, "utf8");
  if (content && !content.endsWith("\n")) {
    throw new Error(`durable history has a partial record: ${basename(path)}`);
  }
  return content;
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
  try {
    mkdirSync(lease, { mode: 0o700 });
  } catch {
    throw new Error(`durable history lease busy: ${lease}`);
  }
  try {
    return action();
  } finally {
    rmSync(lease, { recursive: true, force: true });
  }
}

async function withLeaseAsync<T>(lease: string, action: () => Promise<T>): Promise<T> {
  try {
    await mkdir(lease, { mode: 0o700 });
  } catch {
    throw new Error(`durable history lease busy: ${lease}`);
  }
  try {
    return await action();
  } finally {
    await rm(lease, { recursive: true, force: true });
  }
}
