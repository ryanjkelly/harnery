/**
 * Pid-map writer.
 *
 * Per-harness pid-map at `.harnery/pid-map/<pid>` containing
 * `<instance_id>\t<platform>`. `harn agents whoami` walks ppid up 20 hops looking
 * for a matching entry (preferring the harness, falling back to any platform).
 *
 * Atomic temp+rename. Idempotent: re-writing the same row is a no-op.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
