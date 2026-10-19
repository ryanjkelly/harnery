import { existsSync } from "node:fs";
import {
  observeServiceProcess,
  type ServiceProcessDependencies,
} from "../agents/state/service-process.ts";
import { serviceBuildStatus } from "../events/v3/runtime-build.ts";
import {
  SUPERVISOR_STATUS_SCHEMA_VERSION,
  type SupervisorServiceStatusRecord,
  type SupervisorStatus,
} from "./contract.ts";
import { readSupervisorServiceRecord, supervisorPaths } from "./storage.ts";

const STALE_HEARTBEAT_MS = 15_000;

export function readSupervisorStatus(
  coordRoot: string,
  nowMs = Date.now(),
  dependencies: ServiceProcessDependencies = {},
): SupervisorStatus {
  const paths = supervisorPaths(coordRoot);
  const record = readSupervisorServiceRecord(coordRoot);
  const build = serviceBuildStatus(record?.running_build);
  if (!validRecord(record)) {
    return {
      running: false,
      stale: false,
      generation: "unknown",
      liveness: existsSync(paths.service) ? "unknown" : "stopped",
      ...build,
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
    ...build,
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
