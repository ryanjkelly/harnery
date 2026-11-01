/**
 * Fingerprint of the watched paths outside Git. A change in any watched
 * file's mtime or size, or in a watched directory's direct children, changes
 * the fingerprint and forces an update run (`drift`).
 */

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Expand `~/` (or a bare `~`) and `$VAR` / `${VAR}`. Returns null when a
 * referenced variable is unset, so the entry fingerprints as missing instead
 * of resolving somewhere unintended.
 */
export function expandWatchPath(
  entry: string,
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let unset = false;
  let out = entry.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_m, a, b) => {
      const value = env[(a ?? b) as string];
      if (value === undefined || value === "") {
        unset = true;
        return "";
      }
      return value;
    },
  );
  if (unset) return null;
  if (out === "~" || out.startsWith("~/") || out.startsWith("~\\")) {
    const home = env.HOME || env.USERPROFILE || homedir();
    out = join(home, out.slice(1));
  }
  return isAbsolute(out) ? resolve(out) : resolve(projectRoot, out);
}

function statLine(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.isDirectory() ? "dir" : "file"}\t${Math.trunc(st.mtimeMs)}\t${st.isDirectory() ? 0 : st.size}`;
  } catch {
    return null;
  }
}

/** The raw lines behind the fingerprint (sorted), for diagnostics and tests. */
export function fingerprintLines(
  watch: readonly string[],
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const lines: string[] = [];
  for (const entry of watch) {
    const path = expandWatchPath(entry, projectRoot, env);
    const self = path ? statLine(path) : null;
    if (!path || !self) {
      lines.push(`${entry}\tmissing`);
      continue;
    }
    lines.push(`${entry}\t${self}`);
    if (!self.startsWith("dir\t")) continue;
    let children: string[] = [];
    try {
      children = readdirSync(path);
    } catch {
      children = [];
    }
    for (const child of children) {
      lines.push(`${entry}/${child}\t${statLine(join(path, child)) ?? "missing"}`);
    }
  }
  return lines.sort();
}

/** sha1 hex of the sorted fingerprint lines. */
export function fingerprint(
  watch: readonly string[],
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return createHash("sha1")
    .update(fingerprintLines(watch, projectRoot, env).join("\n"))
    .digest("hex");
}
