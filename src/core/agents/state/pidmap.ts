/**
 * Pid-map writer + liveness helpers.
 *
 * Per-harness pid-map at `.harnery/pid-map/<pid>` containing
 * `<instance_id>\t<platform>`. `harn agents whoami` walks ppid up 20 hops looking
 * for a matching entry (preferring the harness, falling back to any platform).
 *
 * Atomic temp+rename. Idempotent: re-writing the same row is a no-op.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Row count that triggers a dead-row sweep on the next write.
 *
 * Rows are written per hook shell, and those shells exit immediately, so an
 * unattended map only grows. One repo was observed holding 512 rows of which 510
 * were dead. That matters beyond disk: pids get recycled, so a stale row whose
 * number is later reused makes an identity walk resolve to a long-gone agent,
 * and `agents whoami` starts reporting somebody else's session.
 */
const PRUNE_AT_ROWS = 200;

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * Is this pid a running process?
 *
 * `EPERM` means the process exists but belongs to another user, which is still
 * alive. Treating every failure as "dead" would drop a live foreign row and
 * weaken the checks that depend on knowing a claim is anchored.
 */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = liveness probe
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Delete every pid-map row whose process is gone. Returns the number removed. */
export function prunePidmapDeadRows(coordRoot: string): number {
  const dir = join(coordRoot, ".harnery", "pid-map");
  if (!existsSync(dir)) return 0;
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of names) {
    const pid = Number.parseInt(f, 10);
    // Only touch files whose whole name is a pid, so a stray note or a
    // half-written `.tmp.<pid>` file is left where it is.
    if (!Number.isFinite(pid) || String(pid) !== f) continue;
    if (pidIsAlive(pid)) continue;
    try {
      unlinkSync(join(dir, f));
      removed += 1;
    } catch {
      /* best-effort cleanup */
    }
  }
  return removed;
}

export function writePidmapRow(
  coordRoot: string,
  pid: number,
  instanceId: string,
  platform: string,
): void {
  const dir = join(coordRoot, ".harnery", "pid-map");
  const path = join(dir, String(pid));
  const row = `${instanceId}\t${platform}`;
  // Read-then-write idempotency: skip the rename churn when already current.
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === row) return;
    } catch {
      /* fall through to write */
    }
  }
  // Sweep on the way past the threshold. Writes are the only event guaranteed
  // to happen while agents are active, so hanging the sweep here keeps the map
  // bounded without a scheduled job, and the common write stays a single stat.
  try {
    if (existsSync(dir) && readdirSync(dir).length > PRUNE_AT_ROWS) {
      prunePidmapDeadRows(coordRoot);
    }
  } catch {
    /* pruning is best-effort; never fail a write over it */
  }
  atomicWrite(path, row);
}

/** True when any pid-map row for `instanceId` still belongs to a live process. */
export function instanceHasLivePid(coordRoot: string, instanceId: string): boolean {
  const dir = join(coordRoot, ".harnery", "pid-map");
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    let row = "";
    try {
      row = readFileSync(join(dir, f), "utf8").trim();
    } catch {
      continue;
    }
    const owner = row.split("\t")[0]?.trim() ?? "";
    if (owner !== instanceId) continue;
    const pid = Number.parseInt(f, 10);
    if (!Number.isFinite(pid)) continue;
    // Stale rows (ESRCH) keep scanning; a live row settles it.
    if (pidIsAlive(pid)) return true;
  }
  return false;
}

/** Drop every pid-map row owned by `instanceId`. Returns how many files were removed. */
export function removePidmapRowsForInstance(coordRoot: string, instanceId: string): number {
  const dir = join(coordRoot, ".harnery", "pid-map");
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const f of readdirSync(dir)) {
    let row = "";
    try {
      row = readFileSync(join(dir, f), "utf8").trim();
    } catch {
      continue;
    }
    const owner = row.split("\t")[0]?.trim() ?? "";
    if (owner !== instanceId) continue;
    try {
      unlinkSync(join(dir, f));
      removed += 1;
    } catch {
      /* best-effort cleanup */
    }
  }
  return removed;
}
