import { hostname } from "node:os";
import { checkPidToken } from "../agents/state/proc-start.ts";
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
): ResourceServiceStatus {
  const paths = resourcePaths(coordRoot);
  const record = readResourceServiceRecord(coordRoot);
  if (!validRecord(record)) {
    return {
      running: false,
      stale: false,
      status_path: paths.service,
      snapshot_path: paths.snapshot,
    };
  }
  const heartbeatAt = Date.parse(record.heartbeat_at);
  const stale = !Number.isFinite(heartbeatAt) || nowMs - heartbeatAt > STALE_HEARTBEAT_MS;
  const local = record.host === hostname();
  const running =
    local &&
    !stale &&
    (record.state === "starting" || record.state === "running" || record.state === "stopping") &&
    pidStillMatches(record.pid, record.start_token);
  return {
    running,
    stale,
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

function pidStillMatches(pid: number, startToken: string | undefined): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return checkPidToken(pid, startToken) !== "mismatch";
}
