/**
 * The host addendum: a second managed region whose *content* belongs to the
 * consumer.
 *
 * Harnery's orientation block is deliberately generic, because it ships to
 * every consumer (ADR 0007's portability split, ADR 0008's ~80-line budget). A
 * project with real coordination policy of its own therefore had nowhere
 * machine-managed to put it, and ended up hand-maintaining it next to the
 * block, where nothing kept the two in step.
 *
 * The fix is declarative rather than programmatic. A consumer names a file:
 *
 *     // .harnery/config.jsonc
 *     { "instructions": { "hostAddendumFile": ".agents/host-instructions.md" } }
 *
 * and harnery gives that file's contents the same lifecycle as its own block:
 * spliced on `init`, refreshed when the file changes, reported by
 * `init --check`, removed by `deinit` or by deleting the config entry. Harnery
 * never parses, renders, or reasons about what the file says, which is what
 * keeps the arrangement portable: the mechanism is generic even though every
 * consumer's content is not.
 *
 * Exposing the splicer as a public primitive instead would have pushed the
 * whole lifecycle onto each host, since `init` and `deinit` are registered
 * inside harnery and every consumer would have had to wrap or replace them and
 * reimplement apply, check, and remove. The config key keeps one implementation
 * of all four.
 *
 * Every failure here is raised before the caller writes anything.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { stripJsonComments } from "../../core/config.ts";

/** Dotted config key naming the addendum source, quoted in every error. */
export const HOST_ADDENDUM_KEY = "instructions.hostAddendumFile";

/** A host addendum that cannot be used. Callers abort before writing. */
export class HostAddendumError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostAddendumError";
  }
}

export type HostAddendum =
  | { configured: false }
  | { configured: true; relPath: string; body: string };

/**
 * Resolve the configured addendum, or report that there is none.
 *
 * Absent config, absent key, and explicit `null` all mean "not configured",
 * which is how a consumer turns the addendum off: delete the key and re-run
 * `init`. Anything else that cannot become a readable file inside the project
 * throws, because the alternative is an agent-facing instruction file that
 * quietly lost a section the host believes is still there.
 */
export function readHostAddendum(projectRoot: string): HostAddendum {
  const configured = readConfiguredPath(projectRoot);
  if (configured === null) return { configured: false };

  if (typeof configured !== "string" || configured.trim() === "") {
    throw new HostAddendumError(
      `${HOST_ADDENDUM_KEY} must be a repo-relative path to a markdown file`,
    );
  }
  const relPath = configured.trim();

  // An absolute path would name one machine's checkout, and this repo is cloned
  // to a different location on every one of them.
  if (isAbsolute(relPath)) {
    throw new HostAddendumError(
      `${HOST_ADDENDUM_KEY} must be repo-relative, not absolute (got "${relPath}")`,
    );
  }

  const root = resolve(projectRoot);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new HostAddendumError(
      `${HOST_ADDENDUM_KEY} resolves outside the project ("${relPath}"); ` +
        `the addendum must be a committed file in this repo`,
    );
  }

  let body: string;
  try {
    if (statSync(target).isDirectory()) {
      throw new HostAddendumError(`${HOST_ADDENDUM_KEY} points at a directory ("${relPath}")`);
    }
    body = readFileSync(target, "utf8");
  } catch (err) {
    if (err instanceof HostAddendumError) throw err;
    throw new HostAddendumError(
      `${HOST_ADDENDUM_KEY} not found or unreadable ("${relPath}"): ${(err as Error).message}`,
    );
  }

  // Splicing an empty region is never what anyone meant by configuring one, and
  // it fails silently: the file looks fine and the policy simply is not there.
  if (body.trim() === "") {
    throw new HostAddendumError(`${HOST_ADDENDUM_KEY} is empty ("${relPath}")`);
  }

  // Trimmed because the splicer supplies the newlines around a region body;
  // otherwise a trailing newline in the file shows up as a blank line that
  // makes every re-render look like a change.
  return { configured: true, relPath, body: body.trim() };
}

/** The raw config value, or null when the file, the section, or the key is absent. */
function readConfiguredPath(projectRoot: string): unknown {
  const configPath = join(projectRoot, ".harnery", "config.jsonc");
  let parsed: { instructions?: { hostAddendumFile?: unknown } } | null;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")));
  } catch {
    // No config, or one harnery cannot parse. The rest of init already tolerates
    // that, so the addendum does too rather than blocking an unrelated run.
    return null;
  }
  const value = parsed?.instructions?.hostAddendumFile;
  return value === undefined || value === null ? null : value;
}
