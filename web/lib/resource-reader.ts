import {
  RESOURCE_SNAPSHOT_SCHEMA_VERSION,
  type ResourceServiceStatus,
  type ResourceSnapshot,
} from "../../src/core/resources/contract";
import { readResourceServiceStatus } from "../../src/core/resources/service-status";
import { readResourceSnapshot } from "../../src/core/resources/storage";

export interface ResourceDashboardReport {
  service: ResourceServiceStatus;
  snapshot?: ResourceSnapshot;
  freshness_ms: number | null;
}

export function readResourceDashboard(root: string, nowMs = Date.now()): ResourceDashboardReport {
  const service = readResourceServiceStatus(root, nowMs);
  const snapshot = readResourceSnapshot(root);
  const valid =
    snapshot?.schema_version === RESOURCE_SNAPSHOT_SCHEMA_VERSION ? snapshot : undefined;
  const sampledAt = valid ? Date.parse(valid.sampled_at) : Number.NaN;
  return {
    service,
    snapshot: valid,
    freshness_ms: Number.isFinite(sampledAt) ? Math.max(0, nowMs - sampledAt) : null,
  };
}
