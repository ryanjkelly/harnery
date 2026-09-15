import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

/**
 * Present as a normal browser.
 *
 * A desktop-Linux user agent is itself a block signal: web application
 * firewalls commonly deny "X11; Linux" outright because almost no customer
 * browses from desktop Linux, and headless builds announce "HeadlessChrome".
 * Sunbelt Network's Cloudflare rule was the reported case: the same page
 * answered 200 the moment the browser said Windows. Every Harnery page load
 * therefore uses a user agent for the host the operator actually sits at
 * (Windows under WSL or on Windows, macOS on a Mac), never Linux, with the
 * Chrome major version of the browser that is really running.
 *
 * The resolved string is persisted at `~/.cache/harnery/user-agent.json` so
 * every process reuses the one that works; `HARNERY_BROWSER_UA` overrides it
 * for a run (`native` disables the override), and `--user-agent` on `browse`
 * rewrites the stored value.
 */

export type HostFamily = "windows" | "mac";

const STORE_PATH = resolve(homedir(), ".cache", "harnery", "user-agent.json");

/** Windows unless the operator is on a Mac. Linux never presents as Linux. */
export function hostFamily(platform: NodeJS.Platform = process.platform): HostFamily {
  return platform === "darwin" ? "mac" : "windows";
}

/** A current-shape Chrome user agent for the host family and Chrome major. */
export function normalUserAgent(chromeMajor: number, family: HostFamily): string {
  const os = family === "mac" ? "Macintosh; Intel Mac OS X 10_15_7" : "Windows NT 10.0; Win64; x64";
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
}

/** Major version from `<chrome> --version` output, or `undefined`. */
export function parseChromeMajor(versionOutput: string): number | undefined {
  const match = /(\d+)\.\d+\.\d+\.\d+/.exec(versionOutput);
  return match ? Number(match[1]) : undefined;
}

/** Ask an installed Chrome binary for its major version. */
export function chromeMajorFromExecutable(executable: string): number | undefined {
  try {
    const res = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5000 });
    return parseChromeMajor(`${res.stdout ?? ""}${res.stderr ?? ""}`);
  } catch {
    return undefined;
  }
}

export interface StoredUserAgent {
  userAgent: string;
  source: "auto" | "manual";
  chromeMajor?: number;
  updatedAt: string;
}

export function readStoredUserAgent(path: string = STORE_PATH): StoredUserAgent | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredUserAgent>;
    return typeof parsed.userAgent === "string" && parsed.userAgent.length > 0
      ? (parsed as StoredUserAgent)
      : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredUserAgent(entry: StoredUserAgent, path: string = STORE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
}

export interface ResolveUserAgentInput {
  /** Explicit `--user-agent` value: a string, `"native"`, or `"auto"`. */
  requested?: string;
  /** `HARNERY_BROWSER_UA` from the environment. */
  env?: string;
  /** Major version of the Chrome that will actually launch, when known. */
  chromeMajor?: number;
  platform?: NodeJS.Platform;
  storePath?: string;
  now?: () => string;
}

/**
 * The user agent to launch with, or `undefined` for the browser's native
 * string. Precedence: explicit request, then environment, then the stored
 * value (refreshed when the Chrome major moved), then a fresh auto value.
 * An explicit string or `auto` request rewrites the store; `native` does not.
 */
export function resolveUserAgent(input: ResolveUserAgentInput = {}): string | undefined {
  const now = input.now ?? (() => new Date().toISOString());
  const family = hostFamily(input.platform);
  const requested = input.requested?.trim();
  if (requested && requested !== "auto") {
    if (requested === "native") return undefined;
    writeStoredUserAgent(
      { userAgent: requested, source: "manual", updatedAt: now() },
      input.storePath,
    );
    return requested;
  }
  const env = input.env?.trim();
  if (env && requested !== "auto") {
    return env === "native" ? undefined : env;
  }
  const stored = readStoredUserAgent(input.storePath);
  if (
    stored &&
    requested !== "auto" &&
    (stored.source === "manual" ||
      input.chromeMajor === undefined ||
      stored.chromeMajor === input.chromeMajor)
  ) {
    return stored.userAgent;
  }
  const major = input.chromeMajor ?? stored?.chromeMajor ?? 149;
  const userAgent = normalUserAgent(major, family);
  writeStoredUserAgent(
    { userAgent, source: "auto", chromeMajor: major, updatedAt: now() },
    input.storePath,
  );
  return userAgent;
}
