import { createStorageCatalog } from "../storage/catalog.ts";
import {
  HARNERY_STRUCTURED_LOG_PROVIDER_ID,
  type HarneryRegisteredStorageFamily,
} from "../storage/contract.ts";
import type { HarneryLogRecordV1 } from "../storage/jsonl.ts";
import {
  type HarneryLogFollowCursor,
  readLogFollow,
  readRecentActiveLogs,
  rotationFollowCursor,
} from "../storage/query.ts";
import {
  SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
  type SupervisorLogFeed,
  type SupervisorLogLane,
} from "./contract.ts";

const MAX_RECORDS_PER_FAMILY = 100;
const MAX_SEED_BYTES_PER_FAMILY = 256 * 1024;
const MAX_FOLLOW_BYTES_PER_FAMILY = 64 * 1024;

interface LaneState {
  family: HarneryRegisteredStorageFamily;
  cursor: HarneryLogFollowCursor;
  records: HarneryLogRecordV1[];
  truncated: boolean;
  error?: string;
}

export class SupervisorLogCollector {
  readonly #lanes: LaneState[];
  #sequence = 0;

  constructor(coordRoot: string) {
    const catalog = createStorageCatalog({ coord_root: coordRoot, project_root: coordRoot });
    this.#lanes = catalog.families.filter(isStructuredLogFamily).map((family) => seedLane(family));
  }

  async collect(now = new Date()): Promise<SupervisorLogFeed> {
    let changed = this.#sequence === 0;
    for (const lane of this.#lanes) {
      try {
        const followed = await readLogFollow(lane.family, lane.cursor, MAX_FOLLOW_BYTES_PER_FAMILY);
        lane.cursor = followed.cursor;
        if (followed.records.length > 0 || followed.rotated || followed.history_expired) {
          const merged = dedupe([...lane.records, ...followed.records]);
          lane.records = merged.slice(-MAX_RECORDS_PER_FAMILY);
          lane.truncated =
            lane.truncated || followed.history_expired || merged.length > MAX_RECORDS_PER_FAMILY;
          changed = true;
        }
        if (lane.error) changed = true;
        lane.error = undefined;
      } catch (error) {
        const next = error instanceof Error ? error.message : String(error);
        if (next !== lane.error) changed = true;
        lane.error = next;
      }
    }
    if (changed) this.#sequence += 1;
    const lanes: SupervisorLogLane[] = this.#lanes
      .map((lane) => ({
        family_id: lane.family.id,
        owner: lane.family.owner,
        storage_class: lane.family.storage_class as "operational-log" | "debug-log",
        records: lane.records,
        truncated: lane.truncated,
        ...(lane.error ? { error: lane.error } : {}),
      }))
      .sort((left, right) => {
        const activeDelta = Number(right.records.length > 0) - Number(left.records.length > 0);
        return activeDelta || left.family_id.localeCompare(right.family_id);
      });
    return {
      schema_version: SUPERVISOR_LOG_FEED_SCHEMA_VERSION,
      captured_at: now.toISOString(),
      sequence: this.#sequence,
      lanes,
      total_records: lanes.reduce((sum, lane) => sum + lane.records.length, 0),
      unavailable_families: lanes.filter((lane) => lane.error).length,
    };
  }
}

export function recentSupervisorLogs(feed: SupervisorLogFeed, limit = 20): HarneryLogRecordV1[] {
  return feed.lanes
    .flatMap((lane) => lane.records)
    .sort((left, right) => Date.parse(left.emitted_at) - Date.parse(right.emitted_at))
    .slice(-Math.max(0, limit));
}

function seedLane(family: HarneryRegisteredStorageFamily): LaneState {
  try {
    const seed = readRecentActiveLogs(family, {
      max_records: MAX_RECORDS_PER_FAMILY,
      max_bytes: MAX_SEED_BYTES_PER_FAMILY,
    });
    return {
      family,
      cursor: rotationFollowCursor(family),
      records: [...seed.records],
      truncated: seed.truncated,
    };
  } catch (error) {
    return {
      family,
      cursor: rotationFollowCursor(family),
      records: [],
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isStructuredLogFamily(family: HarneryRegisteredStorageFamily): boolean {
  return (
    (family.storage_class === "operational-log" || family.storage_class === "debug-log") &&
    family.provider.provider_id === HARNERY_STRUCTURED_LOG_PROVIDER_ID
  );
}

function dedupe(records: readonly HarneryLogRecordV1[]): HarneryLogRecordV1[] {
  const keyed = new Map<string, HarneryLogRecordV1>();
  for (const record of records) {
    keyed.set(`${record.family_id}:${record.writer_id}:${record.writer_seq}`, record);
  }
  return [...keyed.values()].sort(
    (left, right) => Date.parse(left.emitted_at) - Date.parse(right.emitted_at),
  );
}
