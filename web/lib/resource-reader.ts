import {
  RESOURCE_SNAPSHOT_SCHEMA_VERSION,
  type ResourceSnapshot,
} from "../../src/core/resources/contract";
import { readResourceSnapshot } from "../../src/core/resources/storage";
import type { SupervisorStatus } from "../../src/core/supervisor/contract";
import { readSupervisorStatus } from "../../src/core/supervisor/status";

export interface ResourceDashboardReport {
  service: SupervisorStatus;
  snapshot?: ResourceSnapshot;
  freshness_ms: number | null;
}

export function readResourceDashboard(root: string, nowMs = Date.now()): ResourceDashboardReport {
  const service = readSupervisorStatus(root, nowMs);
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
