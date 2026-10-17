import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  type ProcessGenerationVerdict,
  verifyProcessGeneration,
} from "../agents/state/proc-start.ts";
import { currentHarneryRuntimeBuild, harneryPackageRoot } from "../events/v3/runtime-build.ts";
import {
  SUPERVISOR_STATUS_SCHEMA_VERSION,
  type SupervisorBuild,
  type SupervisorServiceStatusRecord,
  type SupervisorStatus,
} from "./contract.ts";
import { readSupervisorServiceRecord, supervisorPaths } from "./storage.ts";

const STALE_HEARTBEAT_MS = 15_000;

export interface SupervisorProcessDependencies {
  readToken?: (pid: number) => string | null;
  probePid?: (pid: number) => unknown;
}

export function installedSupervisorBuild(): SupervisorBuild {
  let version = "unknown";
  let revision = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(join(harneryPackageRoot(), "package.json"), "utf8"));
    if (typeof pkg.version === "string") version = pkg.version;
    revision = currentHarneryRuntimeBuild();
  } catch {
    // Missing build evidence must still produce an inspectable status.
  }
  return { version, revision };
}

export function readSupervisorStatus(
  coordRoot: string,
  nowMs = Date.now(),
  dependencies: SupervisorProcessDependencies = {},
): SupervisorStatus {
  const paths = supervisorPaths(coordRoot);
  const record = readSupervisorServiceRecord(coordRoot);
  const installedBuild = installedSupervisorBuild();
  const runningBuild = validBuild(record?.running_build) ? record.running_build : null;
  const restartNeeded =
    !runningBuild ||
    installedBuild.version === "unknown" ||
    installedBuild.revision === "unknown" ||
    runningBuild.version !== installedBuild.version ||
    runningBuild.revision !== installedBuild.revision;
  const build = {
    running_build: runningBuild,
    installed_build: installedBuild,
    restart_needed: restartNeeded,
    build_status: !runningBuild
      ? "running build unknown; restart needed"
      : restartNeeded
        ? "restart needed"
        : "current",
  };
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
  const owner = supervisorProcessLiveness(record, dependencies);
  const liveness =
    owner.generation === "same" && record.state === "stopped" ? "stopped" : owner.liveness;
  return {
    running: liveness === "running" && !stale && record.state !== "stopped",
    stale,
    generation: owner.generation,
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

/** A stale heartbeat does not prove that a process has exited. */
export function supervisorProcessLiveness(
  owner: { pid: number; host: string; start_token?: string },
  dependencies: SupervisorProcessDependencies = {},
): { liveness: SupervisorStatus["liveness"]; generation: ProcessGenerationVerdict } {
  if (owner.host !== hostname()) return { liveness: "unknown", generation: "unknown" };
  try {
    (dependencies.probePid ?? ((pid) => process.kill(pid, 0)))(owner.pid);
  } catch (error) {
    return {
      liveness: (error as NodeJS.ErrnoException).code === "ESRCH" ? "stopped" : "unknown",
      generation: "unknown",
    };
  }
  const generation = verifyProcessGeneration(owner.pid, owner.start_token, dependencies.readToken);
  return {
    generation,
    liveness:
      generation === "same" ? "running" : generation === "different" ? "stopped" : "unknown",
  };
}

function validBuild(value: unknown): value is SupervisorBuild {
  if (!value || typeof value !== "object") return false;
  const build = value as Partial<SupervisorBuild>;
  return (
    typeof build.version === "string" &&
    !!build.version &&
    build.version !== "unknown" &&
    typeof build.revision === "string" &&
    !!build.revision &&
    build.revision !== "unknown"
  );
}
