/**
 * The harn CLI entry a detached background process runs with
 * `process.execPath`. Spawning the runtime itself (Node or Bun) with a script
 * works on every platform. Spawning `bin/harn` directly does not: on Windows
 * it is a POSIX shell script that cannot be executed without a shell, and a
 * `new URL(...).pathname` there is `/C:/...`, which `existsSync` rejects.
 *
 * Prefers the sibling `cli` module (the source `.ts` under Bun, the built
 * `.js` under Node) and falls back to the package's `bin/harn.mjs`.
 */

import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

export function harnCliEntry(): string {
  const ext = extname(fileURLToPath(import.meta.url)) || ".js";
  const entry = fileURLToPath(new URL(`../cli${ext}`, import.meta.url));
  if (existsSync(entry)) return entry;
  return fileURLToPath(new URL("../../bin/harn.mjs", import.meta.url));
}
