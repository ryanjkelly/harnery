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

/** Age is never authority to evict an owner. Unknown owners fail closed. */
function reclaimDeadOwner(lock: string): boolean {
  try {
    const stat = lstatSync(lock);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const names = readdirSync(lock);
    if (names.length !== 1 || !/^owner-[0-9a-f-]{36}\.json$/.test(names[0]!)) return false;
    const ownerPath = join(lock, names[0]!);
    const ownerStat = lstatSync(ownerPath);
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 4096) return false;
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LockOwner;
    if (
      owner.version !== 1 ||
      owner.host !== hostname() ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !(owner.process_start === null || typeof owner.process_start === "string")
    )
      return false;
    let dead = false;
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
    } catch (error) {
      dead = (error as NodeJS.ErrnoException).code === "ESRCH";
    }
    if (!dead) return false;
    // Only the contender that removes this unique owner's file may remove the
    // directory. A losing reaper must not unlink a replacement owner's lock.
    unlinkSync(ownerPath);
    rmdirSync(lock);
    return true;
  } catch {
    return false;
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
    if (!reclaimDeadOwner(lock)) {
      throw new Error(
        "artifact store mutation lock unavailable; a live or unverifiable owner holds it. " +
          "Dead local owners recover automatically; an empty or invalid lock requires explicit inspection.",
      );
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
