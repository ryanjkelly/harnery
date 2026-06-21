import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { coordEnv } from "./env.ts";

/**
 * Resolve a human-friendly label for the current machine. Used to tag
 * coordination artifacts (scratch-doc headers, session telemetry) by the host
 * they originated on.
 *
 * Precedence (first non-empty wins):
 *   1. HARNERY_MACHINE env var:          transient / per-launch / CI override
 *   2. ~/.config/harnery/machine file:   persistent, harness-neutral identity
 *   3. os.hostname() (normalized):       automatic floor; never empty
 *
 * The env var sits on top for ad-hoc overrides; the file is the durable home for
 * a machine's name (it survives across Claude Code / Cursor / Codex and GUI
 * launches that don't inherit a shell rc); hostname guarantees a real answer
 * with zero configuration.
 */
export function resolveMachineLabel(): string {
  const fromEnv = coordEnv("MACHINE")?.trim();
  if (fromEnv) return fromEnv;

  const fromFile = readMachineFile();
  if (fromFile) return fromFile;

  return normalizeHost(hostname());
}

/** Absolute path of the machine-label file, honoring XDG_CONFIG_HOME. */
export function machineFilePath(): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return null;
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || resolve(home, ".config");
  return resolve(configHome, "harnery", "machine");
}

/** First non-empty, non-comment line of the machine-label file, or null. */
function readMachineFile(): string | null {
  const path = machineFilePath();
  if (!path || !existsSync(path)) return null;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) return trimmed;
    }
  } catch {
    /* unreadable; fall through to hostname */
  }
  return null;
}

/** Lowercase, strip a trailing `.local` (macOS mDNS suffix). Never empty. */
function normalizeHost(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/\.local$/i, "")
    .toLowerCase();
  return cleaned || "unknown";
}
