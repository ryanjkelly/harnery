import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { processStartToken } from "../agents/state/proc-start.ts";

interface LockOwner {
  version: 1;
  host: string;
  pid: number;
  process_start: string | null;
  acquired_at: string;
}

/**
 * Raised when a verified, live process on this host holds the lock. That is
 * ordinary contention (another caller is mid-mutation), unlike an empty,
 * invalid, or foreign lock, which keeps the plain error because a person may
 * need to inspect it.
 */
export class ArtifactLockBusyError extends Error {
  readonly code = "ARTIFACT_LOCK_BUSY";
  constructor(message: string) {
    super(message);
    this.name = "ArtifactLockBusyError";
  }
}

type OwnerProbe = "reclaimed" | "live" | "unverifiable";

/** Age is never authority to evict an owner. Unknown owners fail closed. */
function reclaimDeadOwner(lock: string): OwnerProbe {
  try {
    const stat = lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "unverifiable";
    const names = readdirSync(lock);
    if (names.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/.test(names[0]!)) return "unverifiable";
    const ownerPath = join(lock, names[0]!);
    const ownerStat = lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 4096)
      return "unverifiable";
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner;
    if (
      owner.version !== 1 ||
      owner.host !== hostname() ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !(owner.process_start === null || typeof owner.process_start === "string")
    )
      return "unverifiable";
    let dead = false;
    let alive = false;
    try {
      process.kill(owner.pid, 0);
      const current = processStartToken(owner.pid);
      // Wall-clock ps lstart output can drift even for a live process. Only
      // boot-scoped procfs ticks establish PID reuse; other probes need ESRCH.
      const bootScoped = /^l[0-9a-f]{8}\.\d+$/;
      dead =
        typeof owner.process_start === "string" &&
        bootScoped.test(owner.process_start) &&
        typeof current === "string" &&
        bootScoped.test(current) &&
        current !== owner.process_start;
      // Contention needs proof the recorded run itself still holds the lock.
      // A recycled or unidentifiable pid stays unverifiable and surfaces.
      alive = typeof owner.process_start === "string" && current === owner.process_start;
    } catch (error) {
      dead = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    if (!dead) return alive ? "live" : "unverifiable";
    // Only the contender that removes this unique owner's file may remove the
    // directory. A losing reaper must not unlink a replacement owner's lock.
    unlinkSync(ownerPath);
    rmdirSync(lock);
    return "reclaimed";
  } catch {
    return "unverifiable";
  }
}

export function withArtifactLock<T>(repoRoot: string, action: () => T): T {
  // Probe before mkdir so a slow platform process probe cannot hold an
  // ownerless lock open while other writers are trying to acquire it.
  const owner: LockOwner = {
    version: 1,
    host: hostname(),
    pid: process.pid,
    process_start: processStartToken(process.pid),
    acquired_at: new Date().toISOString(),
  };
  const lock = join(resolve(repoRoot), ".harnery/artifacts-mutation.lock");
  mkdirSync(dirname(lock), { recursive: true });
  try {
    mkdirSync(lock);
  } catch {
    const probe = reclaimDeadOwner(lock);
    if (probe !== "reclaimed") {
      const message =
        "artifact store mutation lock unavailable; a live or unverifiable owner holds it. " +
        "Dead local owners recover automatically; an empty or invalid lock requires explicit inspection.";
      throw probe === "live" ? new ArtifactLockBusyError(message) : new Error(message);
    }
    // Another caller may win after recovery. Never retry by removing its lock.
    mkdirSync(lock);
  }
  const ownerPath = join(lock, `owner-${randomUUID()}.json`);
  try {
    writeFileSync(ownerPath, JSON.stringify(owner), { flag: "wx" });
    return action();
  } finally {
    // A crash before publication or between these two calls leaves an empty
    // directory. It cannot be distinguished safely from an initializing owner.
    // Publication may have failed before creating a file. Remove only our
    // unique file, then the empty directory; never recursively delete contents.
    rmSync(ownerPath, { force: true });
    rmdirSync(lock);
  }
}
