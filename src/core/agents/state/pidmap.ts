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

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export function writePidmapRow(
  coordRoot: string,
  pid: number,
  instanceId: string,
  platform: string,
): void {
  const path = join(coordRoot, ".harnery", "pid-map", String(pid));
  const row = `${instanceId}\t${platform}`;
  // Read-then-write idempotency: skip the rename churn when already current.
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8") === row) return;
    } catch {
      /* fall through to write */
    }
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
    try {
      process.kill(pid, 0); // signal 0 = liveness probe
      return true;
    } catch {
      // ESRCH (no such process): pid-map entry is stale, keep scanning
    }
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
