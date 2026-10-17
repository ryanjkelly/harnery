import { existsSync } from "node:fs";
import { hostname } from "node:os";
import {
  type ProcessGenerationVerdict,
  verifyProcessGeneration,
} from "../agents/state/proc-start.ts";
import {
  RESOURCE_SERVICE_STATUS_SCHEMA_VERSION,
  type ResourceServiceStatus,
  type ResourceServiceStatusRecord,
} from "./contract.ts";
import { readResourceServiceRecord, resourcePaths } from "./storage.ts";

const STALE_HEARTBEAT_MS = 15_000;

export interface ResourceProcessDependencies {
  readToken?: (pid: number) => string | null;
  probePid?: (pid: number) => unknown;
}

export function readResourceServiceStatus(
  coordRoot: string,
  nowMs = Date.now(),
  dependencies: ResourceProcessDependencies = {},
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
  const owner = resourceProcessLiveness(record, dependencies);
  const liveness =
    owner.generation === "same" && record.state === "stopped" ? "stopped" : owner.liveness;
  return {
    running: liveness === "running" && !stale,
    stale,
    generation: owner.generation,
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

export function resourceProcessLiveness(
  owner: { pid: number; host: string; start_token?: string },
  dependencies: ResourceProcessDependencies = {},
): { generation: ProcessGenerationVerdict; liveness: ResourceServiceStatus["liveness"] } {
  if (owner.host !== hostname()) return { generation: "unknown", liveness: "unknown" };
  try {
    (dependencies.probePid ?? ((pid) => process.kill(pid, 0)))(owner.pid);
  } catch (error) {
    return {
      generation: "unknown",
      liveness: (error as NodeJS.ErrnoException).code === "ESRCH" ? "stopped" : "unknown",
    };
  }
  const generation = verifyProcessGeneration(owner.pid, owner.start_token, dependencies.readToken);
  return {
    generation,
    liveness:
      generation === "same" ? "running" : generation === "different" ? "stopped" : "unknown",
  };
}
