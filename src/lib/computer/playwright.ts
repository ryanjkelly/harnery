/**
 * Playwright extension driver for `harn computer` (ADR 0276).
 *
 * The third pinned driver works in the person's running Chrome through the
 * Playwright Extension instead of the desktop. Harnery installs a pinned
 * `@playwright/mcp` package (npm checks every package against the pinned
 * lockfile's sha512), runs its MCP server as a background daemon in extension
 * mode on the desktop's side (on WSL that is Windows Node, because the server
 * launches the browser's connect page), and gives each agent its own MCP
 * session. The extension keeps each session's tabs in a tab group named after
 * the agent and refuses it every other tab.
 *
 * Calls never touch the desktop, so the command takes the desktop lease only
 * for a call that may come to the front (the first call of a session opens
 * the extension's connect page). The driver applies the browser guard's rules
 * itself (`checkCall`): no typing into password or code fields, a fresh
 * snapshot before a click that follows typing, and no unchecked scripts.
 *
 * Internal module: not exported from package.json.
 */
import { createHash, randomInt } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { windowsExecutable } from "../windows-executable.ts";
import {
  defaultSpawnDetached,
  defaultSpawnSync,
  defaultWslpath,
  normalize,
  parseJson,
  pathApi,
  requireStateDir,
  type SpawnDetachedFn,
  type SpawnSyncFn,
  toCallResult,
  withWslEnv,
  wslPaths,
} from "./driver-support.ts";
import { detectHost } from "./host.ts";
import { PLAYWRIGHT_CLIENT_FILE, PLAYWRIGHT_CLIENT_SOURCE } from "./playwright-client.ts";
import type {
  CallRefusal,
  DaemonStatus,
  DesktopDriver,
  DriverCallResult,
  HostInfo,
  InstallPlan,
  InstallResult,
  PinnedArtifact,
} from "./types.ts";

export const PLAYWRIGHT_DRIVER_ID = "playwright";
/** Pinned `@playwright/mcp`; the lockfile below pins its dependencies too. */
export const PLAYWRIGHT_MCP_VERSION = "0.0.86";
/** The Playwright Extension's Chrome Web Store id. */
export const PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
export const PLAYWRIGHT_EXTENSION_URL = `https://chromewebstore.google.com/detail/playwright-extension/${PLAYWRIGHT_EXTENSION_ID}`;
/** The server requires Node 20 or later. */
export const PLAYWRIGHT_MIN_NODE_MAJOR = 20;
/** The environment variable the server reads the extension's token from. */
export const PLAYWRIGHT_TOKEN_ENV = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";

const PLAYWRIGHT_CORE_VERSION = "1.66.0-alpha-2026-11-18";
const REGISTRY = "https://registry.npmjs.org";

/** The `package.json` written into the install directory. */
export const PLAYWRIGHT_PACKAGE_JSON = {
  name: "harnery-playwright-driver",
  private: true,
  dependencies: { "@playwright/mcp": PLAYWRIGHT_MCP_VERSION },
} as const;

/** The pinned lockfile: `npm ci` refuses any package whose sha512 differs. */
export const PLAYWRIGHT_LOCKFILE = {
  name: "harnery-playwright-driver",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "harnery-playwright-driver",
      dependencies: { "@playwright/mcp": PLAYWRIGHT_MCP_VERSION },
    },
    "node_modules/@playwright/mcp": {
      version: PLAYWRIGHT_MCP_VERSION,
      resolved: `${REGISTRY}/@playwright/mcp/-/mcp-${PLAYWRIGHT_MCP_VERSION}.tgz`,
      integrity:
        "sha512-4SL9OSINmik3+EObCYJIxH8BkhcqqGU6CM8XIgztW015iBVR9WR6Q0xF180Ery+xuEVyyK5r6nC2bOg3zjgCoA==",
      license: "Apache-2.0",
      dependencies: {
        playwright: PLAYWRIGHT_CORE_VERSION,
        "playwright-core": PLAYWRIGHT_CORE_VERSION,
      },
      bin: { "playwright-mcp": "cli.js" },
      engines: { node: ">=20" },
    },
    "node_modules/playwright": {
      version: PLAYWRIGHT_CORE_VERSION,
      resolved: `${REGISTRY}/playwright/-/playwright-${PLAYWRIGHT_CORE_VERSION}.tgz`,
      integrity:
        "sha512-otQ+PFujQwUSpcLjoZ1zocwpEEF/5WhsBKaOuZeRhJ3ifjyRJJskKeosaw55WYdJzwlmfugK7OMX/tey1ExhWQ==",
      license: "Apache-2.0",
      dependencies: { "playwright-core": PLAYWRIGHT_CORE_VERSION },
      bin: { playwright: "cli.js" },
      engines: { node: ">=20" },
    },
    "node_modules/playwright-core": {
      version: PLAYWRIGHT_CORE_VERSION,
      resolved: `${REGISTRY}/playwright-core/-/playwright-core-${PLAYWRIGHT_CORE_VERSION}.tgz`,
      integrity:
        "sha512-VQ60tKPjqhf/3tHJGKuQ8Qn6e28Ziorhpmh4DGBZThgQp5geZeyKmuoJF2o/OwQBs5K7LNkhxNbOclBoAicqPg==",
      license: "Apache-2.0",
      bin: { "playwright-core": "cli.js" },
      engines: { node: ">=20" },
    },
  },
} as const;

const SERVER_ENTRY = "node_modules/@playwright/mcp/cli.js";
const INSTALL_MARKER = ".harnery-install.json";
const CALL_TIMEOUT_MS = 120_000;
const QUICK_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 300_000;
const START_DEADLINE_MS = 20_000;
const START_POLL_MS = 500;
const PORT_MIN = 41_000;
const PORT_MAX = 48_999;
/** Exit code the client uses when the server could not be reached. */
const CLIENT_UNREACHABLE = 3;

/** Tools that enter text; the next click needs a fresh snapshot first. */
const TYPING_TOOLS: ReadonlySet<string> = new Set([
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
]);
/** Tools that click somewhere on the page. */
const POINTING_TOOLS: ReadonlySet<string> = new Set(["browser_click", "browser_drag"]);
/** A read of the page that shows the agent what its typing changed. */
const READ_TOOLS: ReadonlySet<string> = new Set(["browser_snapshot"]);
/** Tools whose arguments name local files. */
const FILE_ARGS: Readonly<Record<string, readonly string[]>> = {
  browser_file_upload: ["paths"],
  browser_take_screenshot: ["filename"],
  browser_snapshot: ["filename"],
  browser_evaluate: ["filename"],
  browser_run_code_unsafe: ["filename"],
};
/** An evaluate function that changes the page instead of reading it. */
const WRITING_SCRIPT =
  /\.value\s*=[^=]|\.click\s*\(|\.submit\s*\(|dispatchEvent\s*\(|innerHTML\s*=|setAttribute\s*\(\s*["']value/;
/** Field names that hold secrets. */
const SENSITIVE_NAME =
  /pass(word|wd|code)?\b|\bpwd\b|\botp\b|one[-_ ]?time|\b2fa\b|\bmfa\b|verification[-_ ]?code|security[-_ ]?code|\bcvv\b|\bcvc\b|card[-_ ]?number|\bpin\b/i;
const SENSITIVE_AUTOCOMPLETE = /current-password|new-password|one-time-code|cc-number|cc-csc/i;

export interface PlaywrightDeps {
  spawnSync?: SpawnSyncFn;
  spawnDetached?: SpawnDetachedFn;
  env?: NodeJS.ProcessEnv;
  home?: () => string;
  wslpath?: (flag: "-w" | "-u", path: string) => string | undefined;
  /** The host the command runs on, for `takesForeground`, which gets no host. */
  host?: () => HostInfo;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Port for a new daemon; defaults to a random port in 41000-48999. */
  pickPort?: () => number;
}

/** One agent's MCP session, kept between `call` processes. */
export interface PlaywrightSession {
  sid: string;
  /** The agent typed since its last snapshot. */
  typed?: boolean;
  started_at: string;
}

interface DaemonRecord {
  pid?: number;
  port: number;
  profile?: string;
  version: string;
  started_at: string;
}

/** A Chrome profile that has the extension, and its token when found. */
export interface ExtensionProfile {
  /** Profile directory name, e.g. "Default" or "Profile 4". */
  dir: string;
  token?: string;
}

/**
 * Read the extension's connection token from the profile's Local Storage
 * files. The extension keeps it in its own origin's localStorage under
 * `auth-token`; LevelDB writes the newest value to a `.log` file and may later
 * move it into a table file, uncompressed for a value this small. Returns the
 * newest value found, or undefined.
 */
export function readExtensionToken(
  files: { name: string; bytes: Uint8Array }[],
): string | undefined {
  const key = Buffer.from(
    `_chrome-extension://${PLAYWRIGHT_EXTENSION_ID}\u0000\u0001auth-token`,
    "latin1",
  );
  const ordered = [...files].sort((a, b) => fileNumber(a.name) - fileNumber(b.name));
  let found: string | undefined;
  for (const file of ordered) {
    const bytes = Buffer.from(file.bytes);
    let at = bytes.indexOf(key);
    while (at >= 0) {
      const value = readStorageValue(bytes, at + key.length);
      if (value) found = value;
      at = bytes.indexOf(key, at + key.length);
    }
  }
  return found;
}

function fileNumber(name: string): number {
  const match = /^(\d+)\./.exec(name);
  return match ? Number(match[1]) : 0;
}

/** A LevelDB value after its key: a varint length, then a 0x01 (Latin-1) or 0x00 (UTF-16) marker. */
function readStorageValue(bytes: Buffer, offset: number): string | undefined {
  let length = 0;
  let shift = 0;
  let i = offset;
  for (; i < bytes.length && shift <= 28; i++) {
    const byte = bytes[i] as number;
    length |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  i++;
  if (length < 2 || length > 512 || i + length > bytes.length) return undefined;
  const marker = bytes[i];
  const body = bytes.subarray(i + 1, i + length);
  const text = marker === 0 ? body.toString("utf16le") : body.toString("latin1");
  return /^[A-Za-z0-9_-]{16,256}$/.test(text) ? text : undefined;
}

/** Tab indexes from a `browser_tabs` list result ("- 0: (current) [Title](url)"). */
export function parseTabIndexes(text: string): number[] {
  const indexes: number[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*-\s*(\d+):/.exec(line);
    if (match) indexes.push(Number(match[1]));
  }
  return indexes;
}

/** The text an agent reads from one tool result: text blocks, with images described. */
export function renderToolResult(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const b = block as { type?: string; text?: string; mimeType?: string; data?: string };
      if (b.type === "text") return b.text ?? "";
      if (b.type === "image")
        return `[${b.mimeType ?? "image"} omitted (${Math.round(((b.data?.length ?? 0) * 3) / 4 / 1024)} KB); pass "filename" to save it]`;
      return `[${b.type ?? "content"} block]`;
    })
    .join("\n");
}

/**
 * The value a `browser_evaluate` call returned, from its result text: the line
 * after "### Result" holds a JSON value, and a function that returned
 * `JSON.stringify(...)` gives a JSON string holding JSON. Undefined when
 * neither parses.
 */
export function parseEvaluateResult(text: string): unknown {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.trim() === "### Result");
  const body = at >= 0 ? lines[at + 1] : undefined;
  if (!body) return undefined;
  try {
    const value = JSON.parse(body) as unknown;
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  } catch {
    return undefined;
  }
}

/** Rewrite the server's output folder (a Windows path on WSL) to the caller's path, slashes included. */
export function rewriteOutputPaths(text: string, serverDir: string, callerDir: string): string {
  if (!serverDir || serverDir === callerDir) return text;
  const escaped = serverDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`${escaped}([^\\s)\\]"'\x60]*)`, "gi"),
    (_m, rest: string) => `${callerDir}${rest.replace(/\\/g, "/")}`,
  );
}

/** Whether one field's attributes mark it as a password, code or card field. */
export function isSensitiveField(field: {
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  label?: string;
}): boolean {
  if ((field.type ?? "").toLowerCase() === "password") return true;
  if (SENSITIVE_AUTOCOMPLETE.test(field.autocomplete ?? "")) return true;
  return [field.name, field.id, field.label].some((v) => !!v && SENSITIVE_NAME.test(v));
}

/** The element targets one typing call enters text into. */
export function typingTargets(tool: string, args: Record<string, unknown>): string[] {
  if (tool === "browser_type" && typeof args.target === "string") return [args.target];
  if (tool === "browser_fill_form" && Array.isArray(args.fields))
    return args.fields
      .filter(
        (f): f is { target: string; type?: string } =>
          !!f && typeof f === "object" && typeof (f as { target?: unknown }).target === "string",
      )
      .filter((f) => f.type === undefined || f.type === "textbox")
      .map((f) => f.target);
  return [];
}

const FIELD_PROBE =
  "(el) => JSON.stringify({type: el.type || '', autocomplete: el.autocomplete || el.getAttribute('autocomplete') || '', name: el.name || '', id: el.id || '', label: el.getAttribute('aria-label') || (el.labels && el.labels[0] ? el.labels[0].textContent : '') || ''})";

export function createPlaywrightDriver(deps: PlaywrightDeps = {}): DesktopDriver {
  const run = deps.spawnSync ?? defaultSpawnSync;
  const env = () => deps.env ?? process.env;
  const home = deps.home ?? homedir;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const pickPort = deps.pickPort ?? (() => randomInt(PORT_MIN, PORT_MAX + 1));
  const wslpath = deps.wslpath ?? defaultWslpath(run, env, QUICK_TIMEOUT_MS);
  const paths = wslPaths(wslpath);
  let windowsNode: string | null | undefined;

  const lockText = `${JSON.stringify(PLAYWRIGHT_LOCKFILE, null, 2)}\n`;
  const lockSha256 = createHash("sha256").update(lockText).digest("hex");
  const clientSha256 = createHash("sha256").update(PLAYWRIGHT_CLIENT_SOURCE).digest("hex");

  const toolsDir = (host: HostInfo) =>
    pathApi(host).join(requireStateDir(host), "tools", "playwright-mcp");
  const installDir = (host: HostInfo) => pathApi(host).join(toolsDir(host), PLAYWRIGHT_MCP_VERSION);
  const outputDir = (host: HostInfo) => pathApi(host).join(toolsDir(host), "output");
  const recordPath = (host: HostInfo) => pathApi(host).join(toolsDir(host), "daemon.json");
  const sessionsPath = (host: HostInfo) => pathApi(host).join(toolsDir(host), "sessions.json");
  /** A path in the syntax of the Node that runs the server. */
  const forNode = (host: HostInfo, path: string) =>
    host.kind === "wsl" ? paths.toWindows(path) : path;

  // ------------------------------------------------------------------ node
  /** The Node executable in the caller's path syntax, or undefined when none is found. */
  function nodeExecutable(host: HostInfo): string | undefined {
    if (host.kind !== "wsl") return "node";
    if (windowsNode !== undefined) return windowsNode ?? undefined;
    const result = run(windowsExecutable("cmd.exe"), ["/c", "where node"], {
      timeout: QUICK_TIMEOUT_MS,
      env: env(),
    });
    const first = normalize(result.stdout)
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /node\.exe$/i.test(l));
    windowsNode = result.status === 0 && first ? paths.toCaller(first) : null;
    return windowsNode ?? undefined;
  }

  function nodeMajor(host: HostInfo): number | undefined {
    const node = nodeExecutable(host);
    if (!node) return undefined;
    const result = run(node, ["--version"], { timeout: QUICK_TIMEOUT_MS, env: env() });
    const match = /^v(\d+)\./.exec(normalize(result.stdout).trim());
    return result.status === 0 && match ? Number(match[1]) : undefined;
  }

  function requireNode(host: HostInfo): string {
    const node = nodeExecutable(host);
    const major = node ? nodeMajor(host) : undefined;
    if (!node || major === undefined)
      throw new Error(
        `The Playwright driver needs Node ${PLAYWRIGHT_MIN_NODE_MAJOR} or later${host.kind === "wsl" ? " installed on Windows" : ""}, and none was found.`,
      );
    if (major < PLAYWRIGHT_MIN_NODE_MAJOR)
      throw new Error(
        `The Playwright driver needs Node ${PLAYWRIGHT_MIN_NODE_MAJOR} or later; found Node ${major}.`,
      );
    return node;
  }

  // -------------------------------------------------------------- profiles
  /** Chrome's user data directory in the caller's path syntax. */
  function chromeUserData(host: HostInfo): string | undefined {
    const p = pathApi(host);
    if (host.kind === "wsl" || host.kind === "windows") {
      const local = p.dirname(requireStateDir(host));
      return p.join(local, "Google", "Chrome", "User Data");
    }
    if (host.kind === "macos")
      return posix.join(home(), "Library", "Application Support", "Google", "Chrome");
    if (host.kind === "linux") return posix.join(home(), ".config", "google-chrome");
    return undefined;
  }

  /** Profiles with the extension, the most recently used first, each with its token when readable. */
  function extensionProfiles(host: HostInfo): ExtensionProfile[] {
    const root = chromeUserData(host);
    if (!root || !existsSync(root)) return [];
    const p = pathApi(host);
    let names: string[] = [];
    try {
      names = readdirSync(root).filter((name) =>
        existsSync(p.join(root, name, "Extensions", PLAYWRIGHT_EXTENSION_ID)),
      );
    } catch {
      return [];
    }
    let order: string[] = [];
    try {
      const state = JSON.parse(readFileSync(p.join(root, "Local State"), "utf8")) as {
        profile?: {
          last_used?: string;
          last_active_profiles?: string[];
          info_cache?: Record<string, { active_time?: number }>;
        };
      };
      const cache = state.profile?.info_cache ?? {};
      order = [
        ...(state.profile?.last_active_profiles ?? []),
        ...(state.profile?.last_used ? [state.profile.last_used] : []),
        ...Object.entries(cache)
          .sort((a, b) => (b[1].active_time ?? 0) - (a[1].active_time ?? 0))
          .map(([name]) => name),
      ];
    } catch {
      order = [];
    }
    const rank = (name: string) => {
      const i = order.indexOf(name);
      return i < 0 ? order.length : i;
    };
    return names
      .sort((a, b) => rank(a) - rank(b))
      .map((dir) => {
        const token = profileToken(p.join(root, dir, "Local Storage", "leveldb"), p);
        return token ? { dir, token } : { dir };
      });
  }

  function profileToken(dir: string, p: typeof posix): string | undefined {
    try {
      const files = readdirSync(dir)
        .filter((name) => name.endsWith(".log") || name.endsWith(".ldb"))
        .map((name) => ({ name, bytes: readFileSync(p.join(dir, name)) }));
      return readExtensionToken(files);
    } catch {
      return undefined;
    }
  }

  function requireProfile(host: HostInfo): Required<ExtensionProfile> {
    const profiles = extensionProfiles(host);
    if (profiles.length === 0)
      throw new Error(
        `The Playwright Extension is not installed in any Chrome profile on this computer. Install it from ${PLAYWRIGHT_EXTENSION_URL}, then try again.`,
      );
    const withToken = profiles.find((profile) => profile.token);
    if (!withToken?.token)
      throw new Error(
        `Found the Playwright Extension in Chrome (${profiles.map((x) => x.dir).join(", ")}) but not its connection token. Click the extension's icon once so it creates the token, then try again.`,
      );
    return { dir: withToken.dir, token: withToken.token };
  }

  // ---------------------------------------------------------------- client
  function clientPath(host: HostInfo): string {
    return pathApi(host).join(installDir(host), PLAYWRIGHT_CLIENT_FILE);
  }

  function ensureClient(host: HostInfo): void {
    const file = clientPath(host);
    try {
      if (readFileSync(file, "utf8") === PLAYWRIGHT_CLIENT_SOURCE) return;
    } catch {
      // write it below
    }
    mkdirSync(pathApi(host).dirname(file), { recursive: true });
    writeFileSync(file, PLAYWRIGHT_CLIENT_SOURCE);
  }

  /** Run one client operation; the JSON it printed, or undefined with the raw result. */
  function client(
    host: HostInfo,
    args: string[],
    timeout = QUICK_TIMEOUT_MS,
  ): { json: Record<string, unknown> | undefined; raw: DriverCallResult } {
    const node = requireNode(host);
    ensureClient(host);
    const result = run(node, [forNode(host, clientPath(host)), ...args], { timeout, env: env() });
    const raw = toCallResult("playwright client", timeout, result);
    const json = parseJson(normalize(result.stdout).trim().split("\n").pop() ?? "");
    return {
      json: json && typeof json === "object" ? (json as Record<string, unknown>) : undefined,
      raw,
    };
  }

  // ----------------------------------------------------------------- state
  function readRecord(host: HostInfo): DaemonRecord | undefined {
    try {
      const value = JSON.parse(readFileSync(recordPath(host), "utf8")) as DaemonRecord;
      return typeof value?.port === "number" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function writeJson(path: string, p: typeof posix, value: unknown): void {
    mkdirSync(p.dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temp, path);
  }

  function readSessions(host: HostInfo): Record<string, PlaywrightSession> {
    try {
      const value = JSON.parse(readFileSync(sessionsPath(host), "utf8")) as unknown;
      return value && typeof value === "object" ? (value as Record<string, PlaywrightSession>) : {};
    } catch {
      return {};
    }
  }

  function updateSession(
    host: HostInfo,
    label: string,
    change: (session: PlaywrightSession | undefined) => PlaywrightSession | undefined,
  ): void {
    const sessions = readSessions(host);
    const next = change(sessions[label]);
    if (next) sessions[label] = next;
    else delete sessions[label];
    writeJson(sessionsPath(host), pathApi(host), sessions);
  }

  const labelOf = (args: Record<string, unknown>) =>
    typeof args.session === "string" && args.session !== "" ? args.session : "default";

  function withoutSession(args: Record<string, unknown>): Record<string, unknown> {
    const { session: _session, ...rest } = args;
    return rest;
  }

  // ---------------------------------------------------------------- daemon
  function daemonStatus(host: HostInfo): DaemonStatus {
    const record = readRecord(host);
    if (!record) return { running: false, detail: "not started" };
    if (!installedExecutable(host)) return { running: false, detail: "not installed" };
    let reached = false;
    try {
      const { json } = client(host, ["ping", String(record.port)]);
      reached = typeof json?.status === "number";
    } catch {
      reached = false;
    }
    if (!reached) return { running: false, detail: `not answering on port ${record.port}` };
    return {
      running: true,
      detail: `serving on 127.0.0.1:${record.port}${record.profile ? ` for Chrome profile "${record.profile}"` : ""}`,
      // Extension mode always works in the person's browser; there is no grant to add.
      browserAttach: true,
      ...(record.pid !== undefined ? { pid: record.pid } : {}),
      version: record.version,
    };
  }

  async function startDaemon(host: HostInfo): Promise<DaemonStatus> {
    const current = daemonStatus(host);
    if (current.running) return current;
    const cli = installedExecutable(host);
    if (!cli)
      throw new Error(
        "The Playwright driver is not installed; run `computer install --driver playwright --yes`.",
      );
    const node = requireNode(host);
    const profile = requireProfile(host);
    const port = pickPort();
    const p = pathApi(host);
    mkdirSync(outputDir(host), { recursive: true });
    const serverArgs = [
      forNode(host, cli),
      "--extension",
      "--profile-dir-name",
      profile.dir,
      "--background",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--output-dir",
      forNode(host, outputDir(host)),
    ];
    const serverEnv = { ...env(), [PLAYWRIGHT_TOKEN_ENV]: profile.token };
    let pid: number | undefined;
    if (host.kind === "wsl" || host.kind === "windows") {
      const quote = (arg: string) => `'${(/\s/.test(arg) ? `"${arg}"` : arg).replace(/'/g, "''")}'`;
      const command = `(Start-Process -FilePath ${quote(forNode(host, node))} -ArgumentList ${serverArgs.map(quote).join(",")} -WindowStyle Hidden -PassThru).Id`;
      const result = run(windowsExecutable("powershell.exe"), ["-NoProfile", "-Command", command], {
        timeout: 30_000,
        env: host.kind === "wsl" ? withWslEnv(serverEnv, [PLAYWRIGHT_TOKEN_ENV]) : serverEnv,
      });
      if (result.status !== 0)
        throw new Error(
          `Starting the Playwright server failed: ${normalize(
            result.stderr || result.stdout || result.error?.message || "no output",
          )
            .trim()
            .slice(0, 400)}`,
        );
      const id = Number(normalize(result.stdout).trim().split("\n").pop());
      if (Number.isFinite(id) && id > 0) pid = id;
    } else {
      (deps.spawnDetached ?? defaultSpawnDetached)(node, serverArgs, serverEnv);
    }
    writeJson(recordPath(host), p, {
      ...(pid !== undefined ? { pid } : {}),
      port,
      profile: profile.dir,
      version: PLAYWRIGHT_MCP_VERSION,
      started_at: new Date(now()).toISOString(),
    } satisfies DaemonRecord);
    // A new server knows none of the old sessions.
    writeJson(sessionsPath(host), p, {});
    const deadline = now() + START_DEADLINE_MS;
    let status = daemonStatus(host);
    while (!status.running && now() < deadline) {
      await sleep(START_POLL_MS);
      status = daemonStatus(host);
    }
    return status;
  }

  function stopDaemon(host: HostInfo): DaemonStatus {
    const record = readRecord(host);
    if (record?.pid !== undefined) {
      if (host.kind === "wsl" || host.kind === "windows")
        run(
          windowsExecutable("powershell.exe"),
          [
            "-NoProfile",
            "-Command",
            `Stop-Process -Id ${record.pid} -Force -ErrorAction SilentlyContinue`,
          ],
          { timeout: QUICK_TIMEOUT_MS, env: env() },
        );
      else
        try {
          process.kill(record.pid);
        } catch {
          // already gone
        }
    }
    const status = daemonStatus(host);
    if (!status.running) {
      try {
        writeJson(sessionsPath(host), pathApi(host), {});
      } catch {
        // best effort
      }
    }
    return status;
  }

  // --------------------------------------------------------------- install
  function installedExecutable(host: HostInfo): string | undefined {
    if (host.kind === "unsupported" || !host.desktopStateDir) return undefined;
    const p = pathApi(host);
    const dir = installDir(host);
    try {
      const marker = JSON.parse(readFileSync(p.join(dir, INSTALL_MARKER), "utf8")) as {
        version?: string;
        lock_sha256?: string;
      };
      if (marker.version !== PLAYWRIGHT_MCP_VERSION || marker.lock_sha256 !== lockSha256)
        return undefined;
    } catch {
      return undefined;
    }
    const cli = p.join(dir, SERVER_ENTRY);
    return existsSync(cli) ? cli : undefined;
  }

  function planInstall(host: HostInfo): InstallPlan {
    const dir = installDir(host);
    const p = pathApi(host);
    const artifact: PinnedArtifact = {
      version: PLAYWRIGHT_MCP_VERSION,
      fileName: "package-lock.json",
      url: `${REGISTRY}/@playwright/mcp/-/mcp-${PLAYWRIGHT_MCP_VERSION}.tgz`,
      sha256: lockSha256,
      format: "tar.gz",
      executableEntry: SERVER_ENTRY,
    };
    const setup: string[] = [];
    let profiles: ExtensionProfile[] = [];
    try {
      profiles = extensionProfiles(host);
    } catch {
      profiles = [];
    }
    if (profiles.length === 0)
      setup.push(`Install the Playwright Extension in Chrome: ${PLAYWRIGHT_EXTENSION_URL}`);
    else if (!profiles.some((x) => x.token))
      setup.push("Click the Playwright Extension's icon once so it creates its connection token.");
    let nodeNote: string | undefined;
    try {
      requireNode(host);
    } catch (error) {
      nodeNote = (error as Error).message;
    }
    if (nodeNote) setup.push(nodeNote);
    return {
      driver: PLAYWRIGHT_DRIVER_ID,
      version: PLAYWRIGHT_MCP_VERSION,
      host: host.kind,
      artifact,
      installDir: dir,
      executable: p.join(dir, SERVER_ENTRY),
      alreadyInstalled: installedExecutable(host) !== undefined,
      steps: [
        "write the pinned package.json and package-lock.json (sha256 above is the lockfile's)",
        "npm ci --ignore-scripts: npm refuses any package whose sha512 differs from the lockfile",
        `write the Harnery MCP client (${PLAYWRIGHT_CLIENT_FILE})`,
      ],
      ...(setup.length > 0 ? { setup } : {}),
    };
  }

  async function install(plan: InstallPlan): Promise<InstallResult> {
    const host: HostInfo = deps.host?.() ?? detectHost();
    if (host.kind === "unsupported") throw new Error("Computer use is not supported on this host.");
    if (plan.alreadyInstalled) {
      ensureClient(host);
      return { ...plan, installed: false };
    }
    const node = requireNode(host);
    const p = pathApi(host);
    const dir = plan.installDir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      p.join(dir, "package.json"),
      `${JSON.stringify(PLAYWRIGHT_PACKAGE_JSON, null, 2)}\n`,
    );
    writeFileSync(p.join(dir, "package-lock.json"), lockText);
    const npmArgs = [
      "ci",
      "--prefix",
      forNode(host, dir),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ];
    const result =
      host.kind === "wsl"
        ? run(
            node,
            [
              forNode(host, p.join(p.dirname(node), "node_modules", "npm", "bin", "npm-cli.js")),
              ...npmArgs,
            ],
            { timeout: INSTALL_TIMEOUT_MS, env: env() },
          )
        : run(host.kind === "windows" ? "npm.cmd" : "npm", npmArgs, {
            timeout: INSTALL_TIMEOUT_MS,
            env: env(),
          });
    if (result.status !== 0)
      throw new Error(
        `npm ci failed for the Playwright driver: ${normalize(
          result.stderr || result.stdout || result.error?.message || "no output",
        )
          .trim()
          .slice(-600)}`,
      );
    if (!existsSync(p.join(dir, SERVER_ENTRY)))
      throw new Error(`npm ci finished but ${SERVER_ENTRY} is missing in ${dir}.`);
    ensureClient(host);
    writeFileSync(
      p.join(dir, INSTALL_MARKER),
      `${JSON.stringify({ version: PLAYWRIGHT_MCP_VERSION, lock_sha256: lockSha256, client_sha256: clientSha256, installed_at: new Date(now()).toISOString() }, null, 2)}\n`,
    );
    return { ...plan, alreadyInstalled: false, installed: true };
  }

  // ----------------------------------------------------------------- calls
  function requirePort(host: HostInfo): number {
    const record = readRecord(host);
    if (!record)
      throw new Error(
        "The Playwright server is not running; start it with `computer up --driver playwright`.",
      );
    return record.port;
  }

  function openSession(host: HostInfo, port: number, label: string): string {
    const { json, raw } = client(host, ["init", String(port), label]);
    const sid = typeof json?.sid === "string" ? json.sid : undefined;
    if (!sid)
      throw new Error(
        `The Playwright server did not open a session: ${raw.stderr.trim() || JSON.stringify(json ?? raw.stdout.trim()).slice(0, 300)}`,
      );
    updateSession(host, label, () => ({ sid, started_at: new Date(now()).toISOString() }));
    return sid;
  }

  /** One raw tool call on the agent's session, opening or reopening it as needed. */
  function callTool(
    host: HostInfo,
    label: string,
    tool: string,
    args: Record<string, unknown>,
  ): { result: unknown; error: unknown; raw: DriverCallResult } {
    const port = requirePort(host);
    let sid = readSessions(host)[label]?.sid ?? openSession(host, port, label);
    const payload = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
    const once = () =>
      client(
        host,
        ["call", String(port), sid, tool, payload, String(CALL_TIMEOUT_MS)],
        CALL_TIMEOUT_MS + 5_000,
      );
    let { json, raw } = once();
    // The server restarted or dropped the session: open a new one and retry once.
    if (json?.status === 404) {
      sid = openSession(host, port, label);
      ({ json, raw } = once());
    }
    if (raw.exitCode === CLIENT_UNREACHABLE || json?.unreachable)
      throw new Error(
        `The Playwright server on port ${port} did not answer; restart it with \`computer down --driver playwright\` and \`computer up --driver playwright\`.`,
      );
    return { result: json?.result ?? null, error: json?.error ?? null, raw };
  }

  function call(host: HostInfo, tool: string, args: Record<string, unknown>): DriverCallResult {
    const label = labelOf(args);
    const { result, error, raw } = callTool(host, label, tool, withoutSession(args));
    if (error || !result) {
      const message = error
        ? JSON.stringify(error)
        : raw.stderr.trim() || raw.stdout.trim() || "no result";
      return { exitCode: 1, stdout: "", stderr: `${tool} failed: ${message}\n` };
    }
    const failed = (result as { isError?: boolean }).isError === true;
    if (!failed) {
      if (TYPING_TOOLS.has(tool))
        updateSession(host, label, (s) => (s ? { ...s, typed: true } : s));
      else if (READ_TOOLS.has(tool))
        updateSession(host, label, (s) => (s ? { ...s, typed: false } : s));
    }
    const text = renderToolResult(result);
    return {
      exitCode: failed ? 1 : 0,
      stdout: text.endsWith("\n") ? text : `${text}\n`,
      stderr: "",
      json: result,
    };
  }

  function checkCall(
    host: HostInfo,
    tool: string,
    args: Record<string, unknown>,
  ): CallRefusal | undefined {
    if (tool === "browser_run_code_unsafe")
      return {
        code: "browser_script_not_checked",
        message:
          "browser_run_code_unsafe runs a whole Playwright program that the guard cannot check step by step, so it was not sent.",
        hint: "Use the single-step tools (browser_navigate, browser_snapshot, browser_click, browser_type) instead.",
      };
    if (
      tool === "browser_evaluate" &&
      typeof args.function === "string" &&
      WRITING_SCRIPT.test(args.function)
    )
      return {
        code: "browser_script_not_checked",
        message:
          "This browser_evaluate function changes the page (sets a value, clicks, submits or dispatches events), which the guard cannot check, so it was not sent.",
        hint: "Use browser_evaluate only to read the page; act with browser_click, browser_type or browser_fill_form.",
      };
    const label = labelOf(args);
    const session = readSessions(host)[label];
    if (POINTING_TOOLS.has(tool) && session?.typed)
      return {
        code: "browser_read_back_required",
        message:
          "You typed since your last browser_snapshot, so this click was not sent: what you typed can open a menu or an offer over the element you meant.",
        hint: "Call browser_snapshot, check the target is still what you expect, then click.",
      };
    const targets = typingTargets(tool, args);
    if (targets.length > 0 && session) {
      for (const target of targets) {
        let field: Record<string, string> | undefined;
        try {
          const probe = callTool(host, label, "browser_evaluate", {
            function: FIELD_PROBE,
            target,
            element: "the field about to be typed into",
          });
          field = parseEvaluateResult(renderToolResult(probe.result)) as
            | Record<string, string>
            | undefined;
        } catch {
          field = undefined;
        }
        if (field && isSensitiveField(field))
          return {
            code: "browser_sensitive_field",
            message: `Target ${target} is a password, one-time code or card field, so nothing was typed into it.`,
            hint: "Agents never type secrets. Leave the field for the person, or sign in through the person's password manager as the harn-computer skill describes.",
          };
      }
    }
    return undefined;
  }

  function endAgentWork(host: HostInfo, label: string): string[] {
    try {
      if (host.kind === "unsupported" || !host.desktopStateDir) return [];
      const session = readSessions(host)[label];
      if (!session) return [];
      const record = readRecord(host);
      if (!record || !daemonStatus(host).running) {
        updateSession(host, label, () => undefined);
        return [];
      }
      let closed = 0;
      try {
        const listed = callTool(host, label, "browser_tabs", { action: "list" });
        const indexes = parseTabIndexes(renderToolResult(listed.result)).sort((a, b) => b - a);
        for (const index of indexes) {
          const r = callTool(host, label, "browser_tabs", { action: "close", index });
          if (r.result && (r.result as { isError?: boolean }).isError !== true) closed++;
        }
      } catch {
        // report what was closed
      }
      try {
        client(host, ["end", String(record.port), session.sid]);
      } catch {
        // the session is forgotten either way
      }
      updateSession(host, label, () => undefined);
      return [
        `Closed ${closed} Playwright tab${closed === 1 ? "" : "s"} and ended the Playwright session for ${label}.`,
      ];
    } catch {
      return [];
    }
  }

  function takesForeground(tool: string, args: Record<string, unknown>): boolean {
    // The first call of a session opens the extension's connect page, which
    // a browser older than Chrome 158 shows in front.
    try {
      const host = deps.host?.() ?? detectHost();
      if (host.kind === "unsupported" || !host.desktopStateDir) return false;
      return readSessions(host)[labelOf(args)] === undefined && tool !== "browser_tabs";
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------- catalog
  function catalog(host: HostInfo): Record<string, unknown>[] | undefined {
    const record = readRecord(host);
    if (!record || !installedExecutable(host)) return undefined;
    try {
      const { json } = client(host, ["tools", String(record.port)]);
      return Array.isArray(json?.tools) ? (json.tools as Record<string, unknown>[]) : undefined;
    } catch {
      return undefined;
    }
  }

  function listTools(host: HostInfo): DriverCallResult {
    const tools = catalog(host);
    if (!tools)
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "The Playwright server is not running; start it with `computer up --driver playwright`.\n",
      };
    const lines = tools.map((t) => `${t.name}: ${String(t.description ?? "").split("\n")[0]}`);
    return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
  }

  function describe(host: HostInfo, tool: string): DriverCallResult {
    const found = catalog(host)?.find((t) => t.name === tool);
    if (!found) return { exitCode: 1, stdout: "", stderr: `No Playwright tool named ${tool}.\n` };
    const text = JSON.stringify(
      { name: found.name, description: found.description, inputSchema: found.inputSchema },
      null,
      2,
    );
    return { exitCode: 0, stdout: `${text}\n`, stderr: "", json: found };
  }

  function health(host: HostInfo): DriverCallResult {
    const checks: { name: string; status: "pass" | "fail" | "warn"; message: string }[] = [];
    let major: number | undefined;
    try {
      major = nodeMajor(host);
    } catch {
      major = undefined;
    }
    checks.push(
      major === undefined
        ? {
            name: "node",
            status: "fail",
            message: `Node ${PLAYWRIGHT_MIN_NODE_MAJOR}+ not found${host.kind === "wsl" ? " on Windows" : ""}`,
          }
        : major < PLAYWRIGHT_MIN_NODE_MAJOR
          ? {
              name: "node",
              status: "fail",
              message: `Node ${major} is older than ${PLAYWRIGHT_MIN_NODE_MAJOR}`,
            }
          : { name: "node", status: "pass", message: `Node ${major}` },
    );
    checks.push(
      installedExecutable(host)
        ? {
            name: "package",
            status: "pass",
            message: `@playwright/mcp ${PLAYWRIGHT_MCP_VERSION} installed`,
          }
        : {
            name: "package",
            status: "fail",
            message: "not installed; run computer install --driver playwright --yes",
          },
    );
    const profiles = extensionProfiles(host);
    const tokened = profiles.find((x) => x.token);
    checks.push(
      profiles.length === 0
        ? {
            name: "extension",
            status: "fail",
            message: `not installed in Chrome: ${PLAYWRIGHT_EXTENSION_URL}`,
          }
        : {
            name: "extension",
            status: "pass",
            message: `installed in Chrome profile ${profiles.map((x) => `"${x.dir}"`).join(", ")}`,
          },
    );
    checks.push(
      tokened
        ? { name: "token", status: "pass", message: `found for profile "${tokened.dir}"` }
        : {
            name: "token",
            status: "fail",
            message: "no connection token yet; click the extension's icon once",
          },
    );
    const daemon = daemonStatus(host);
    checks.push({
      name: "server",
      status: daemon.running ? "pass" : "warn",
      message: daemon.detail,
    });
    const json = { checks };
    const failed = checks.some((c) => c.status === "fail");
    return { exitCode: failed ? 1 : 0, stdout: `${JSON.stringify(json)}\n`, stderr: "", json };
  }

  // ----------------------------------------------------------------- paths
  function translateArgsPaths(
    host: HostInfo,
    tool: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (host.kind !== "wsl") return args;
    const keys = FILE_ARGS[tool];
    if (!keys) return args;
    const out = { ...args };
    const convert = (value: unknown) =>
      typeof value === "string" && value.startsWith("/") ? paths.toWindows(value) : value;
    for (const key of keys) {
      const value = out[key];
      out[key] = Array.isArray(value) ? value.map(convert) : convert(value);
    }
    return out;
  }

  function translateResultPaths(host: HostInfo, stdout: string): string {
    if (host.kind !== "wsl" || !host.desktopStateDir) return stdout;
    return rewriteOutputPaths(stdout, paths.toWindows(outputDir(host)), outputDir(host));
  }

  return {
    id: PLAYWRIGHT_DRIVER_ID,
    version: PLAYWRIGHT_MCP_VERSION,
    summary:
      "the person's running Chrome through the Playwright Extension; each agent works in its own tab group in the background, without the desktop",
    hasDaemon: true,
    usesDesktop: false,
    callTimeoutMs: CALL_TIMEOUT_MS + 10_000,
    takesForeground,
    attachesPersonBrowser: () => true,
    checkCall,
    endAgentWork,
    planInstall,
    install,
    installedExecutable,
    daemonStatus,
    startDaemon,
    stopDaemon,
    call,
    listTools,
    describe,
    health,
    translateArgsPaths,
    translateResultPaths,
  };
}

export const playwrightDriver: DesktopDriver = createPlaywrightDriver();
