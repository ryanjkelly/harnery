/**
 * `.harnery/config.jsonc` reader: the host-project config the coord/hook layer
 * consults when it can't see the consumer CLI's own process.
 *
 * The single field this module owns today is `binName`: the host CLI's binary
 * name (e.g. `myapp`), used in user-facing strings the agent reads and runs:
 * council prompts, end-of-turn nudges, command help/errors. The coord binaries
 * (`agent-hook`, `agent-coord`) and the web UI run as harnery itself, so they
 * have no other way to learn the consumer's bin name; `harn init` stamps it here
 * for them to read back. The `files` deny/override section is parsed separately
 * by `web/lib/files.ts`.
 *
 * Dependency-free (no jsonc npm dep) so it runs on both Bun and Node, and so the
 * ADR-009 vendored copies stay portable.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { coordEnv } from "../lib/env.ts";
import { findCoordRoot } from "./hooks/resolve/coord-root.ts";

/** The standalone CLI's bin name: the resolution floor when nothing else is set. */
export const DEFAULT_BIN_NAME = "harn";

interface HarneryConfig {
  /** Host CLI bin name, stamped by `harn init` for a consumer (e.g. "acme"). */
  binName?: string;
  /**
   * Host-specific command that (re)installs the project's git hooks, surfaced
   * verbatim in the "commit guard not wired" nudge. Optional: harnery doesn't
   * own git-hook installation (each host wires its own pre-commit to invoke
   * `agent-coord verdict`), and the path/command is host-specific, so the host
   * declares it here (e.g. "scripts/setup-hooks.sh"). Unset → a generic hint.
   */
  hooksSetupHint?: string;
  [k: string]: unknown;
}

/** Strip `//` and `/* *​/` comments from JSONC, ignoring comment-like runs inside strings. */
export function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < input.length) {
        out += input[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// mtime-keyed per-process cache: a stat is cheap, a parse on every render isn't.
let cache: { root: string; mtimeMs: number; cfg: HarneryConfig } | null = null;

function readConfig(root: string): HarneryConfig {
  const p = join(root, ".harnery", "config.jsonc");
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(p).mtimeMs;
  } catch {
    /* missing → -1; cache still valid until the file appears */
  }
  if (cache && cache.root === root && cache.mtimeMs === mtimeMs) return cache.cfg;
  let cfg: HarneryConfig = {};
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(p, "utf8"))) as HarneryConfig | null;
    if (parsed && typeof parsed === "object") cfg = parsed;
  } catch {
    /* missing or unparseable → defaults (the files-section resolver fails loud; bin name is non-critical) */
  }
  cache = { root, mtimeMs, cfg };
  return cfg;
}

/**
 * Resolve the host CLI's bin name for user-facing strings. Precedence:
 *   1. `HARNERY_BIN` env (explicit per-process override)
 *   2. `.harnery/config.jsonc` `binName` (stamped by `harn init`)
 *   3. `"harn"` (standalone default)
 *
 * `coordRoot` is resolved via `findCoordRoot()` when not passed.
 */
export function resolveBinName(coordRoot?: string | null): string {
  const env = coordEnv("BIN");
  if (env?.trim()) return env.trim();
  const root = coordRoot ?? findCoordRoot();
  if (root) {
    const binName = readConfig(root).binName;
    if (typeof binName === "string" && binName.trim()) return binName.trim();
  }
  return DEFAULT_BIN_NAME;
}

/**
 * The host's git-hook (re)install command, for the "commit guard not wired"
 * nudge. Returns the configured `hooksSetupHint` (e.g. "scripts/setup-hooks.sh")
 * or null when unset — callers fall back to a generic, host-agnostic message.
 * `coordRoot` is resolved via `findCoordRoot()` when not passed.
 */
export function resolveHooksSetupHint(coordRoot?: string | null): string | null {
  const root = coordRoot ?? findCoordRoot();
  if (!root) return null;
  const hint = readConfig(root).hooksSetupHint;
  return typeof hint === "string" && hint.trim() ? hint.trim() : null;
}
