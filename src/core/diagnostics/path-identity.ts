import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PERSONAL_DIR_MODE, PERSONAL_FILE_MODE } from "../storage/modes.ts";

const HOME_PATH =
  /(?:[A-Za-z]:[\\/]Users[\\/](?:[^\\/\r\n\0:"<>|]+(?=[\\/])|[^\\/\s\0:]+)|\/home\/[^/\s\0:]+|\/Users\/[^/\s\0:]+)/g;

const KEY_PATTERN = /^[0-9a-f]{64}$/;
let cachedKey: Buffer | undefined;

/**
 * Per-install secret for home-path pseudonyms. An unkeyed digest would let
 * anyone holding a bundle recover the user name by hashing guesses, so the
 * key stays in local state and never enters a bundle. Sanitized values carry
 * the pseudonym itself, so replay elsewhere needs no key.
 */
function identityKeyPath(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg?.trim() ? xdg : join(homedir(), ".local", "state");
  return join(base, "harnery", "diagnostic-identity.key");
}

function readKey(path: string): Buffer | undefined {
  try {
    const text = readFileSync(path, "utf8").trim();
    return KEY_PATTERN.test(text) ? Buffer.from(text, "hex") : undefined;
  } catch {
    return undefined;
  }
}

function identityKey(): Buffer {
  if (cachedKey) return cachedKey;
  const path = identityKeyPath();
  let key = readKey(path);
  if (!key) {
    const fresh = randomBytes(32);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: PERSONAL_DIR_MODE });
      writeFileSync(path, `${fresh.toString("hex")}\n`, { flag: "wx", mode: PERSONAL_FILE_MODE });
      chmodSync(path, PERSONAL_FILE_MODE);
      key = fresh;
    } catch {
      // A concurrent writer won the race, or state is unwritable. Prefer the
      // stored key; otherwise stay private with a process-local key.
      key = readKey(path) ?? fresh;
    }
  }
  cachedKey = key;
  return key;
}

/** One stable, non-reversible representation for private home paths in values and identity inputs. */
export function canonicalizeDiagnosticIdentity(value: string): string {
  return value.replace(HOME_PATH, (home) => {
    const digest = createHmac("sha256", identityKey()).update(home).digest("hex");
    return `[REDACTED:home:${digest}]`;
  });
}
