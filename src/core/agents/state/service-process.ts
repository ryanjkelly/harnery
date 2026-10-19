/**
 * One owner check for every singleton background service (governor, local
 * supervisor, legacy resource observer): is the recorded process still the
 * run that wrote the record, and how is a stop requested?
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { writePrivateJsonAtomic } from "../../storage/atomic-json.ts";
import { stateDirMode, stateFileMode } from "../../storage/modes.ts";
import {
  type ProcessGenerationSignalDependencies,
  type ProcessGenerationVerdict,
  processStartToken,
  signalIfSameGeneration,
  verifyProcessGeneration,
} from "./proc-start.ts";

export interface ServiceProcessDependencies extends ProcessGenerationSignalDependencies {
  /** Throws ESRCH, or returns false, when the process is gone. */
  probePid?: (pid: number) => unknown;
}

export type ServiceLiveness = "running" | "stopped" | "unknown";

export interface ServiceProcessOwner {
  pid: number;
  host: string;
  start_token?: string;
  state?: string;
}

/**
 * A stale heartbeat does not prove that a process has exited. Another host, a
 * probe error other than ESRCH, or an unverifiable token answers unknown. A
 * recorded `stopped` state counts only while the generation still matches.
 */
export function observeServiceProcess(
  owner: ServiceProcessOwner,
  dependencies: ServiceProcessDependencies = {},
): { generation: ProcessGenerationVerdict; liveness: ServiceLiveness } {
  if (owner.host !== hostname()) return { generation: "unknown", liveness: "unknown" };
  try {
    if ((dependencies.probePid ?? ((pid) => process.kill(pid, 0)))(owner.pid) === false)
      return { generation: "unknown", liveness: "stopped" };
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
      generation === "same"
        ? owner.state === "stopped"
          ? "stopped"
          : "running"
        : generation === "different"
          ? "stopped"
          : "unknown",
  };
}

/** Refuse a start while another owner runs or cannot be identified. */
export function serviceStartRefusal(
  label: string,
  stopCommand: string,
  pid: number | undefined,
  liveness: ServiceLiveness,
): Error {
  return new Error(
    liveness === "running"
      ? `${label} is already running under pid ${pid}`
      : `${label} process generation is unknown${pid ? ` for pid ${pid}` : ""}; run \`${stopCommand}\` to write a durable stop request before starting it again`,
  );
}

export interface ServiceLease {
  pid: number;
  start_token?: string;
  host: string;
  nonce: string;
  created_at?: string;
}

export function readServiceLease(path: string): ServiceLease | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ServiceLease>;
    if (
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.host !== "string" ||
      !value.host ||
      typeof value.nonce !== "string" ||
      !value.nonce
    )
      return undefined;
    return {
      ...value,
      start_token: typeof value.start_token === "string" ? value.start_token : undefined,
    } as ServiceLease;
  } catch {
    return undefined;
  }
}

/** An absent lease is stopped; an unreadable one cannot be identified. */
export function serviceLeaseOwner(path: string): {
  lease?: ServiceLease;
  liveness: ServiceLiveness;
} {
  if (!existsSync(path)) return { liveness: "stopped" };
  const lease = readServiceLease(path);
  return { lease, liveness: lease ? observeServiceProcess(lease).liveness : "unknown" };
}

/**
 * Take the singleton lease with an exclusive create. A lease whose owner is
 * proven stopped is replaced; any other owner refuses the start.
 */
export function acquireServiceLease(
  path: string,
  refuse: (pid: number | undefined, liveness: ServiceLiveness) => Error,
  fields: Record<string, unknown> = {},
): { nonce: string; release: () => void } {
  mkdirSync(dirname(path), { recursive: true, mode: stateDirMode() });
  for (let attempt = 0; attempt < 2; attempt++) {
    const startToken = processStartToken(process.pid);
    const lease = {
      ...fields,
      pid: process.pid,
      ...(startToken ? { start_token: startToken } : {}),
      host: hostname(),
      nonce: randomUUID(),
      created_at: new Date().toISOString(),
    };
    try {
      const fd = openSync(path, "wx", stateFileMode());
      try {
        writeFileSync(fd, `${JSON.stringify(lease)}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return {
        nonce: lease.nonce,
        release: () => {
          if (readServiceLease(path)?.nonce !== lease.nonce) return;
          try {
            unlinkSync(path);
          } catch {
            // A missing lease is already released.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = serviceLeaseOwner(path);
      if (owner.liveness !== "stopped") throw refuse(owner.lease?.pid, owner.liveness);
      try {
        unlinkSync(path);
      } catch {
        // A concurrent starter may have replaced or removed the stale lease.
      }
    }
  }
  throw new Error(`could not acquire the singleton lease at ${path}`);
}

export interface ServiceStopFields {
  signal_sent: boolean;
  signal_verdict: ProcessGenerationVerdict;
}

/**
 * Write the durable stop request, then SIGTERM the owner `status` observed as
 * running on this host, after a fresh generation check. The request stays for
 * the daemon either way; `read` reports the state afterward.
 */
export function requestServiceStop<
  S extends {
    liveness: ServiceLiveness;
    generation: ProcessGenerationVerdict;
    record?: ServiceProcessOwner;
  },
>(
  status: S,
  read: () => S,
  stopPath: string,
  dependencies: ServiceProcessDependencies = {},
  options: { signal?: boolean } = {},
): S & ServiceStopFields {
  writePrivateJsonAtomic(stopPath, {
    requested_at: new Date().toISOString(),
    requested_by_pid: process.pid,
  });
  const signal =
    options.signal !== false && status.liveness === "running" && status.record?.host === hostname()
      ? signalIfSameGeneration(
          status.record.pid,
          status.record.start_token,
          "SIGTERM",
          dependencies,
        )
      : { sent: false, verdict: status.generation };
  return { ...read(), signal_sent: signal.sent, signal_verdict: signal.verdict };
}
