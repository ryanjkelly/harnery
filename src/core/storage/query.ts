import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
}

export interface HarneryLogFollowCursor {
  family_id: string;
  manifest_sequence: number;
  active_offset: number;
}

const LEVELS: readonly HarneryLogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

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
  for (const family of families) {
    if (query.family_ids && !query.family_ids.includes(family.id)) continue;
    const directory = familyLogDirectory(family);
    const sources = manifestSources(directory, family);
    for (const source of sources) {
      for await (const line of linesFrom(source.path, source.gzip)) {
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
  return { records, records_examined: examined, bytes_examined: bytes, truncated };
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
    active_offset: existsSync(active) ? statSync(active).size : 0,
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
}> {
  if (cursor.family_id !== family.id) throw new Error("follow cursor family mismatch");
  const directory = familyLogDirectory(family);
  const manifest = readSegmentManifest(directory, family);
  const rotated = manifest.next_sequence - 1 > cursor.manifest_sequence;
  const active = join(directory, "active.jsonl");
  if (!existsSync(active)) return { records: [], cursor: rotationFollowCursor(family), rotated };
  const content = readFileSync(active);
  const offset = rotated || cursor.active_offset > content.byteLength ? 0 : cursor.active_offset;
  const slice = content.subarray(offset, Math.min(content.byteLength, offset + maxBytes));
  const lastNewline = slice.lastIndexOf(10);
  const consumed = lastNewline < 0 ? 0 : lastNewline + 1;
  const records = slice
    .subarray(0, consumed)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map(parseLogRecord);
  return {
    records,
    cursor: {
      family_id: family.id,
      manifest_sequence: manifest.next_sequence - 1,
      active_offset: offset + consumed,
    },
    rotated,
  };
}

function manifestSources(
  directory: string,
  family: HarneryRegisteredStorageFamily,
): Array<{ path: string; gzip: boolean }> {
  const manifest = readSegmentManifest(directory, family);
  const sealed = manifest.segments
    .map((segment) => ({ path: join(directory, segment.file), gzip: true }))
    .filter((source) => existsSync(source.path));
  const active = join(directory, "active.jsonl");
  return existsSync(active) ? [...sealed, { path: active, gzip: false }] : sealed;
}

async function* linesFrom(path: string, gzip: boolean): AsyncGenerator<string> {
  const input = createReadStream(path);
  const stream = gzip ? input.pipe(createGunzip()) : input;
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) yield line;
}

function matches(record: HarneryLogRecordV1, query: HarneryLogQuery): boolean {
  if (query.minimum_level && LEVELS.indexOf(record.level) < LEVELS.indexOf(query.minimum_level))
    return false;
  if (query.event && record.event !== query.event) return false;
  if (query.since && record.emitted_at < query.since) return false;
  if (query.until && record.emitted_at > query.until) return false;
  return Object.entries(query.context ?? {}).every(([key, value]) => record.context[key] === value);
}
