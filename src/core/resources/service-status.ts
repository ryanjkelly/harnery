import { existsSync } from "node:fs";
import {
  observeServiceProcess,
  type ServiceProcessDependencies,
} from "../agents/state/service-process.ts";
import {
  RESOURCE_SERVICE_STATUS_SCHEMA_VERSION,
  type ResourceServiceStatus,
  type ResourceServiceStatusRecord,
} from "./contract.ts";
import { readResourceServiceRecord, resourcePaths } from "./storage.ts";

const STALE_HEARTBEAT_MS = 15_000;

export function readResourceServiceStatus(
  coordRoot: string,
  nowMs = Date.now(),
  dependencies: ServiceProcessDependencies = {},
): ResourceServiceStatus {
  const paths = resourcePaths(coordRoot);
  const record = readResourceServiceRecord(coordRoot);
  if (!validRecord(record)) {
    return {
      running: false,
      stale: false,
      generation: "unknown",
      liveness: existsSync(paths.service) ? "unknown" : "stopped",
      status_path: paths.service,
      snapshot_path: paths.snapshot,
    };
  }
  const heartbeatAt = Date.parse(record.heartbeat_at);
  const stale = !Number.isFinite(heartbeatAt) || nowMs - heartbeatAt > STALE_HEARTBEAT_MS;
  const { generation, liveness } = observeServiceProcess(record, dependencies);
  return {
    running: liveness === "running" && !stale,
    stale,
    generation,
    liveness,
    record,
    status_path: paths.service,
    snapshot_path: paths.snapshot,
  };
}

function validRecord(
  value: ResourceServiceStatusRecord | undefined,
): value is ResourceServiceStatusRecord {
  return (
    value?.schema_version === RESOURCE_SERVICE_STATUS_SCHEMA_VERSION &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.host === "string" &&
    typeof value.heartbeat_at === "string"
  );
}
