/**
 * Editor-indexer exclusions for the `.harnery/` coord root.
 *
 * `harn init` already writes `.harnery/.gitignore`, which keeps git-aware
 * tools out of runtime state. Two high-traffic editor surfaces ignore
 * gitignore, though: Cursor's codebase indexer (governed by a repo-root
 * `.cursorindexingignore`) and the VS Code/Cursor file watcher (governed by
 * `files.watcherExclude` in `.vscode/settings.json`). A busy coord root holds
 * tens of thousands of ledger events plus working artifacts, so on
 * session-heavy hosts the missing exclusions turn editor startup into an
 * indexing storm over machine-local state no editor needs to see.
 *
 * `applyIndexerExclusions` is idempotent and non-destructive: it appends a
 * managed entry to `.cursorindexingignore` (or creates the file) and merges a
 * single key into `.vscode/settings.json` (or creates it). A settings file it
 * cannot merge safely (comments, malformed JSON, or a non-object
 * `files.watcherExclude`) is left byte-identical and reported as a manual
 * step. `removeIndexerExclusions` reverses exactly what apply wrote: it never
 * removes a `.harnery/` ignore entry the consumer added themselves (detected
 * by the absence of the managed comment) and never edits a settings file it
 * could not have written into.
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CURSOR_IGNORE = ".cursorindexingignore";
const MANAGED_COMMENT =
  "# .harnery/ is machine-local harnery runtime state (entry managed by init)";
const MANAGED_ENTRY = ".harnery/";
const VSCODE_DIR = ".vscode";
const VSCODE_SETTINGS = ".vscode/settings.json";
const WATCHER_KEY = "files.watcherExclude";
const WATCHER_GLOB = "**/.harnery/**";

/** True when a `.cursorindexingignore` line already excludes the coord root. */
function coversCoordRoot(line: string): boolean {
  const t = line.trim();
  return (
    t === ".harnery" ||
    t === ".harnery/" ||
    t === "/.harnery" ||
    t === "/.harnery/" ||
    t === ".harnery/**" ||
    t === "/.harnery/**"
  );
}

function applyCursorIgnore(projectRoot: string, dryRun: boolean): string {
  const path = resolve(projectRoot, CURSOR_IGNORE);
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    if (raw.split("\n").some(coversCoordRoot)) {
      return `· ${CURSOR_IGNORE} already excludes .harnery/`;
    }
    if (dryRun) return `+ would append .harnery/ to ${CURSOR_IGNORE}`;
    const sep = raw === "" || raw.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${raw}${sep}${MANAGED_COMMENT}\n${MANAGED_ENTRY}\n`);
    return `+ appended .harnery/ to ${CURSOR_IGNORE}`;
  }
  if (dryRun) return `+ would create ${CURSOR_IGNORE} (excludes .harnery/ from Cursor indexing)`;
  writeFileSync(path, `${MANAGED_COMMENT}\n${MANAGED_ENTRY}\n`);
  return `+ created ${CURSOR_IGNORE} (excludes .harnery/ from Cursor indexing)`;
}

function applyVscodeWatcherExclude(projectRoot: string, dryRun: boolean): string {
  const path = resolve(projectRoot, VSCODE_SETTINGS);
  if (!existsSync(path)) {
    if (dryRun) return `+ would create ${VSCODE_SETTINGS} (file watcher excludes .harnery/)`;
    mkdirSync(resolve(projectRoot, VSCODE_DIR), { recursive: true });
    const body = JSON.stringify({ [WATCHER_KEY]: { [WATCHER_GLOB]: true } }, null, 2);
    writeFileSync(path, `${body}\n`);
    return `+ created ${VSCODE_SETTINGS} (file watcher excludes .harnery/)`;
  }
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // JSONC (comments, trailing commas) or malformed. A rewrite would drop the
    // consumer's comments, so leave the file alone and name the one-key merge.
    return `! ${VSCODE_SETTINGS} is not plain JSON; add "${WATCHER_KEY}": {"${WATCHER_GLOB}": true} manually`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return `! ${VSCODE_SETTINGS} is not a settings object; add "${WATCHER_KEY}": {"${WATCHER_GLOB}": true} manually`;
  }
  const settings = parsed as Record<string, unknown>;
  const watcher = settings[WATCHER_KEY];
  if (
    watcher !== undefined &&
    (typeof watcher !== "object" || watcher === null || Array.isArray(watcher))
  ) {
    return `! ${VSCODE_SETTINGS} has a non-object "${WATCHER_KEY}"; add "${WATCHER_GLOB}": true manually`;
  }
  const map = (watcher as Record<string, unknown> | undefined) ?? {};
  if (map[WATCHER_GLOB] === true) {
    return `· ${VSCODE_SETTINGS} file watcher already excludes .harnery/`;
  }
  if (dryRun) return `+ would add ${WATCHER_GLOB} to ${WATCHER_KEY} in ${VSCODE_SETTINGS}`;
  map[WATCHER_GLOB] = true;
  settings[WATCHER_KEY] = map;
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return `+ added ${WATCHER_GLOB} to ${WATCHER_KEY} in ${VSCODE_SETTINGS}`;
}

function removeCursorIgnore(projectRoot: string, dryRun: boolean): string | null {
  const path = resolve(projectRoot, CURSOR_IGNORE);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  // Only the managed pair is ours. A bare `.harnery/` line without the managed
  // comment is a consumer's own entry and stays.
  if (!lines.some((line) => line.trim() === MANAGED_COMMENT)) return null;
  if (dryRun) return `+ would remove the managed .harnery/ entry from ${CURSOR_IGNORE}`;
  const kept = lines.filter((line) => {
    const t = line.trim();
    return t !== MANAGED_COMMENT && t !== MANAGED_ENTRY;
  });
  if (kept.every((line) => line.trim() === "")) {
    rmSync(path);
    return `+ removed ${CURSOR_IGNORE} (was harnery-only)`;
  }
  let out = kept.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  writeFileSync(path, out);
  return `+ removed the managed .harnery/ entry from ${CURSOR_IGNORE}`;
}

function removeVscodeWatcherExclude(projectRoot: string, dryRun: boolean): string | null {
  const path = resolve(projectRoot, VSCODE_SETTINGS);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Not plain JSON, so apply never wrote into it.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const settings = parsed as Record<string, unknown>;
  const watcher = settings[WATCHER_KEY];
  if (typeof watcher !== "object" || watcher === null || Array.isArray(watcher)) return null;
  const map = watcher as Record<string, unknown>;
  if (!(WATCHER_GLOB in map)) return null;
  if (dryRun) return `+ would remove ${WATCHER_GLOB} from ${VSCODE_SETTINGS}`;
  delete map[WATCHER_GLOB];
  if (Object.keys(map).length === 0) delete settings[WATCHER_KEY];
  if (Object.keys(settings).length === 0) {
    rmSync(path);
    try {
      // Drop the .vscode/ directory too when the settings file was all it held.
      rmdirSync(resolve(projectRoot, VSCODE_DIR));
    } catch {
      // Non-empty or shared; leave it.
    }
    return `+ removed ${VSCODE_SETTINGS} (was harnery-only)`;
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return `+ removed ${WATCHER_GLOB} from ${VSCODE_SETTINGS}`;
}

/** Ensure both editor exclusions exist. Returns init-style action lines. */
export function applyIndexerExclusions(projectRoot: string, dryRun: boolean): string[] {
  return [applyCursorIgnore(projectRoot, dryRun), applyVscodeWatcherExclude(projectRoot, dryRun)];
}

/** Reverse exactly what apply wrote. Returns action lines; silent when nothing is ours. */
export function removeIndexerExclusions(projectRoot: string, dryRun: boolean): string[] {
  return [
    removeCursorIgnore(projectRoot, dryRun),
    removeVscodeWatcherExclude(projectRoot, dryRun),
  ].filter((line): line is string => line !== null);
}
