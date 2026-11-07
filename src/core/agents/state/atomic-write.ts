import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a coordination state file so readers never see a partial write:
 * write a per-process temp file beside it, then rename it into place.
 */
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
