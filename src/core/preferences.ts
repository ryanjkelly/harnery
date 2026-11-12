/**
 * A person's own choices that follow them across every project, kept in
 * `~/.config/harnery/preferences.json` (honors `XDG_CONFIG_HOME`). One section
 * per preference. Machine-written JSON, never committed, and never merged with
 * a project's `.harnery/config.jsonc`.
 *
 * This module imports only Node built-ins and `helper-limit.ts`, so an adapter
 * plugin can bundle it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type HelperLimit, parseStoredHelperLimit } from "./helper-limit.ts";

export interface Preferences {
  /** Helper limit per adapter id (`claude-code`, …). A present, empty object is
   * the explicit "no limit" choice. */
  helpers?: Record<string, HelperLimit>;
}

/** `~/.config/harnery/preferences.json`. */
export function preferencesPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg?.trim() ? xdg : join(homedir(), ".config");
  return join(base, "harnery", "preferences.json");
}

function readRaw(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed: treated as no preferences.
  }
  return {};
}

/** The person's preferences; a missing file and malformed entries are ignored. */
export function readPreferences(path = preferencesPath()): Preferences {
  const raw = readRaw(path);
  const out: Preferences = {};
  const helpers = raw.helpers;
  if (typeof helpers === "object" && helpers !== null && !Array.isArray(helpers)) {
    const parsed: Record<string, HelperLimit> = {};
    for (const [tool, value] of Object.entries(helpers)) {
      const limit = parseStoredHelperLimit(value);
      if (limit) parsed[tool] = limit;
    }
    if (Object.keys(parsed).length > 0) out.helpers = parsed;
  }
  return out;
}

/**
 * Save the helper limit for one adapter, or remove the choice with `null` so
 * the next layer applies. Sections this version does not know are kept. The
 * write goes through a temp file and a rename, so a reader never sees half a
 * file.
 */
export function writeHelperLimit(
  tool: string,
  limit: HelperLimit | null,
  path = preferencesPath(),
): void {
  const raw = readRaw(path);
  const current = raw.helpers;
  const helpers: Record<string, unknown> =
    typeof current === "object" && current !== null && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  if (limit === null) delete helpers[tool];
  else helpers[tool] = { ...limit };
  if (Object.keys(helpers).length > 0) raw.helpers = helpers;
  else delete raw.helpers;
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(raw, null, 2)}\n`);
  renameSync(temp, path);
}
