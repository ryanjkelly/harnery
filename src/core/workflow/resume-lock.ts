// Kept apart from run-state.ts: the resume lock reads process identity, and
// run-state.ts is also reached from read-only dashboard modules.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { processStartToken, verifyProcessGeneration } from "../agents/state/proc-start.ts";
import { stateFileMode } from "../storage/modes.ts";
import { assertWorkflowRunId } from "./approvals.ts";

export type WorkflowResumeOwnerState = "dead" | "live" | "unknown";

export interface WorkflowResumeLockOwner {
  pid: number;
  host: string;
  created_at: string;
  start_token?: string | null;
}

/** Acquire the exclusive lease shared by resume and reclaim. A lock whose
 * same-host owner has exited, or whose PID now names a different process, is
 * retired automatically. Every other existing lock refuses. */
export function acquireWorkflowResumeLease(coordRoot: string, runId: string): () => void {
  const path = workflowResumeLockPath(coordRoot, runId);
  const owner = {
    owner_id: randomUUID(),
    pid: process.pid,
    host: hostname(),
    created_at: new Date().toISOString(),
    start_token: processStartToken(process.pid),
  };
  const ownerBytes = `${JSON.stringify(owner)}\n`;
  mkdirSync(dirname(path), { recursive: true });

  const acquire = (): { device: number; inode: number } | false => {
    try {
      const fd = openSync(path, "wx", stateFileMode());
      try {
        writeFileSync(fd, ownerBytes, "utf8");
      } finally {
        closeSync(fd);
      }
      chmodSync(path, stateFileMode());
      const identity = lstatSync(path);
      return { device: identity.dev, inode: identity.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };

  const acquired = acquire() || (retireDeadResumeLock(path) && acquire());
  if (!acquired) {
    const existing = readWorkflowResumeLock(coordRoot, runId);
    const holder = existing
      ? ` by pid ${existing.pid} on ${existing.host} (owner ${workflowResumeOwnerState(existing)})`
      : "; its owner could not be read";
    throw new Error(`workflow run ${runId} resume lease is already held${holder}`);
  }

  return () => {
    try {
      // Pin identity and bytes, so a stale closure never removes a replacement.
      const identity = lstatSync(path);
      if (
        identity.isFile() &&
        identity.dev === acquired.device &&
        identity.ino === acquired.inode &&
        readFileSync(path, "utf8") === ownerBytes
      ) {
        unlinkSync(path);
      }
    } catch {
      // Leave an unreadable or replaced lock untouched.
    }
  };
}

export function workflowResumeLockPath(coordRoot: string, runId: string): string {
  assertWorkflowRunId(runId);
  return join(coordRoot, ".harnery", "workflows", runId, "resume.lock");
}

/** Only a same-host owner can be proven gone: by ESRCH, or by a recorded start
 * token that no longer matches its PID. Foreign and unreadable owners stay live. */
export function workflowResumeOwnerState(owner: WorkflowResumeLockOwner): WorkflowResumeOwnerState {
  if (owner.host !== hostname()) return "unknown";
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code !== "EPERM") return "unknown";
  }
  return verifyProcessGeneration(owner.pid, owner.start_token) === "different" ? "dead" : "live";
}

/** Move a dead owner's exact lock aside before deleting it. If a contender
 * replaced it in between, the moved bytes (a fresh owner_id) differ, and that
 * live lock is linked back. */
function retireDeadResumeLock(path: string): boolean {
  let bytes: string;
  try {
    bytes = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const owner = parseResumeLock(bytes);
  if (!owner || workflowResumeOwnerState(owner) !== "dead") return false;
  const aside = `${path}.dead-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const exact = readFileSync(aside, "utf8") === bytes;
  if (!exact) {
    try {
      linkSync(aside, path);
    } catch {
      // A third contender already holds the path; the moved owner's release
      // finds a different inode and leaves that lock alone.
    }
  }
  unlinkSync(aside);
  return exact;
}

export function readWorkflowResumeLock(
  coordRoot: string,
  runId: string,
): WorkflowResumeLockOwner | null {
  return readResumeLease(workflowResumeLockPath(coordRoot, runId));
}

function readResumeLease(path: string): WorkflowResumeLockOwner | null {
  try {
    return parseResumeLock(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseResumeLock(bytes: string): WorkflowResumeLockOwner | null {
  try {
    const value = JSON.parse(bytes) as Record<string, unknown>;
    return typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.host === "string" &&
      value.host.length > 0 &&
      validTimestamp(value.created_at)
      ? {
          pid: value.pid,
          host: value.host,
          created_at: value.created_at,
          start_token: typeof value.start_token === "string" ? value.start_token : null,
        }
      : null;
  } catch {
    return null;
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}
