import { hostname } from "node:os";
import { checkPidToken } from "../agents/state/proc-start.ts";
import {
  SUPERVISOR_STATUS_SCHEMA_VERSION,
  type SupervisorServiceStatusRecord,
  type SupervisorStatus,
} from "./contract.ts";
import { readSupervisorServiceRecord, supervisorPaths } from "./storage.ts";

const STALE_HEARTBEAT_MS = 15_000;

export function readSupervisorStatus(coordRoot: string, nowMs = Date.now()): SupervisorStatus {
  const paths = supervisorPaths(coordRoot);
  const record = readSupervisorServiceRecord(coordRoot);
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
  const running =
    record.host === hostname() &&
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
  value: SupervisorServiceStatusRecord | undefined,
): value is SupervisorServiceStatusRecord {
  return (
    value?.schema_version === SUPERVISOR_STATUS_SCHEMA_VERSION &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.host === "string" &&
    typeof value.heartbeat_at === "string" &&
    typeof value.keep_alive === "boolean"
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
