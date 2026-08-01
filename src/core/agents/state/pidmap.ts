/**
 * Pid-map writer + liveness helpers.
 *
 * Per-adapter pid-map at `.harnery/pid-map/<pid>` containing
 * `<instance_id>\t<platform>\t<start_token>`. `harn agents whoami` walks ppid up
 * 20 hops looking for a matching entry (preferring the adapter, falling back to
 * any platform).
 *
 * The start token pins each row to one *run* of that pid, because a pid on its
 * own is a number the OS re-issues — see `proc-start.ts` for how fast. Rows
 * written before tokens existed carry two fields and read as unverified, which
 * behaves exactly as they always did.
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
import { checkPidToken, processStartToken } from "./proc-start.ts";

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

/** Split a row into its fields, tolerating the pre-token two-field shape. */
export function parsePidmapRow(row: string): {
  instanceId: string;
  platform: string;
  startToken: string | undefined;
} {
  const [instanceId = "", platform = "", startToken = ""] = row.trim().split("\t");
  return { instanceId, platform, startToken: startToken || undefined };
}

/**
 * Is this row still about the process it was written for?
 *
 * Two ways to fail. The pid may have exited, which a liveness probe catches.
 * Or the pid may have been re-issued to an unrelated process, which a liveness
 * probe cannot catch — that pid is alive — and which the start token does.
 * Getting the second one wrong resolves an identity walk to a long-gone agent
 * and keeps a dead agent's heartbeat looking live, so the check belongs
 * everywhere a row is believed, not only where it is swept.
 */
function rowStillNamesItsProcess(pid: number, startToken: string | undefined): boolean {
  if (!pidIsAlive(pid)) return false;
  return checkPidToken(pid, startToken) !== "mismatch";
}

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

/**
 * Delete every pid-map row that no longer names its process — exited, or its
 * pid re-issued to something else. Returns the number removed.
 */
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
    let token: string | undefined;
    try {
      token = parsePidmapRow(readFileSync(join(dir, f), "utf8")).startToken;
    } catch {
      /* unreadable row: fall back to the liveness check alone */
    }
    if (rowStillNamesItsProcess(pid, token)) continue;
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
  // Stamped at write time, when the pid provably belongs to the process we
  // mean. A platform that will not say gets no third field rather than an empty
  // one, so an unverifiable row stays byte-identical to what came before.
  const startToken = processStartToken(pid);
  const row = startToken
    ? `${instanceId}\t${platform}\t${startToken}`
    : `${instanceId}\t${platform}`;
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

/**
 * True when any pid-map row for `instanceId` still belongs to a live process.
 *
 * Callers spend this answer on consequential things — whether a commit guard
 * treats a heartbeat as a live peer, whether a name can be reclaimed from an
 * abandoned session — so a re-issued pid must not read as that agent still
 * running.
 */
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
    const { instanceId: owner, startToken } = parsePidmapRow(row);
    if (owner !== instanceId) continue;
    const pid = Number.parseInt(f, 10);
    if (!Number.isFinite(pid)) continue;
    // Rows that no longer name their process keep the scan going; one that does
    // settles it.
    if (rowStillNamesItsProcess(pid, startToken)) return true;
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
    if (parsePidmapRow(row).instanceId !== instanceId) continue;
    try {
      unlinkSync(join(dir, f));
      removed += 1;
    } catch {
      /* best-effort cleanup */
    }
  }
  return removed;
}
