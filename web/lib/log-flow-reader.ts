import { createStorageCatalog } from "../../src/core/storage/catalog";
import { HARNERY_STRUCTURED_LOG_PROVIDER_ID } from "../../src/core/storage/contract";
import type { HarneryLogRecordV1 } from "../../src/core/storage/jsonl";
import { readRecentActiveLogs } from "../../src/core/storage/query";
import { coordRoot } from "./coord-reader";

export interface LogFlowLane {
  familyId: string;
  owner: string;
  storageClass: "operational-log" | "debug-log";
  records: readonly HarneryLogRecordV1[];
  truncated: boolean;
  error: string | null;
}

export interface LogFlowSnapshot {
  capturedAt: string;
  lanes: readonly LogFlowLane[];
  totalRecords: number;
  unavailableFamilies: number;
}

const MAX_RECORDS_PER_FAMILY = 160;
const MAX_BYTES_PER_FAMILY = 256 * 1024;

/** Read every managed structured-log family independently so one bad lane cannot blank the view. */
export function readLogFlowSnapshot(root = coordRoot()): LogFlowSnapshot {
  const catalog = createStorageCatalog({ coord_root: root, project_root: root });
  const lanes: LogFlowLane[] = [];
  for (const family of catalog.families) {
    if (family.storage_class !== "operational-log" && family.storage_class !== "debug-log")
      continue;
    if (family.provider.provider_id !== HARNERY_STRUCTURED_LOG_PROVIDER_ID) continue;
    try {
      const recent = readRecentActiveLogs(family, {
        max_records: MAX_RECORDS_PER_FAMILY,
        max_bytes: MAX_BYTES_PER_FAMILY,
      });
      lanes.push({
        familyId: family.id,
        owner: family.owner,
        storageClass: family.storage_class,
        records: recent.records,
        truncated: recent.truncated,
        error: null,
      });
    } catch (error) {
      lanes.push({
        familyId: family.id,
        owner: family.owner,
        storageClass: family.storage_class,
        records: [],
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  lanes.sort((a, b) => {
    const activeDelta = Number(b.records.length > 0) - Number(a.records.length > 0);
    return activeDelta || a.familyId.localeCompare(b.familyId);
  });
  return {
    capturedAt: new Date().toISOString(),
    lanes,
    totalRecords: lanes.reduce((sum, lane) => sum + lane.records.length, 0),
    unavailableFamilies: lanes.filter((lane) => lane.error).length,
  };
}
