import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import type {
  BrowserSessionInspection,
  BrowserSessionLocator,
  BrowserSessionScreenshot,
  BrowserSessionStatus,
  BrowserSessionTab,
} from "./client.ts";

export const BROWSER_SESSION_PROTOCOL_VERSION = 1 as const;
export const BROWSER_SESSION_MAX_FRAME_BYTES = 1024 * 1024;
export const BROWSER_SESSION_MAX_FILL_BYTES = 64 * 1024;
export const BROWSER_SESSION_MAX_INSPECTION_TEXT_BYTES = 256 * 1024;

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const SHORT_ACTION_TIMEOUT_MS = 5_000;
const UNIX_SOCKET_MAX_BYTES = 100;
const ARIA_ROLES = new Set([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "meter",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);

export interface BrowserSessionDescriptor {
  version: typeof BROWSER_SESSION_PROTOCOL_VERSION;
  pid: number;
  created_at: string;
  transport: { kind: "unix"; address: string } | { kind: "pipe"; address: string };
  token: string;
}

export type BrowserSessionRequest =
  | BaseRequest<"status", Record<string, never>>
  | BaseRequest<"inspect", { locator?: BrowserSessionLocator }>
  | BaseRequest<"screenshot", { out: string }>
  | BaseRequest<"tabs", Record<string, never>>
  | BaseRequest<"select_tab", { index: number }>
  | BaseRequest<"open_tab", { url: string }>
  | BaseRequest<"close_tab", { index: number }>
  | BaseRequest<"goto", { url: string }>
  | BaseRequest<"reload", Record<string, never>>
  | BaseRequest<"click", { locator: BrowserSessionLocator }>
  | BaseRequest<"fill", { locator: BrowserSessionLocator; value: string }>
  | BaseRequest<"press", { key: string }>
  | BaseRequest<"wait", { locator: BrowserSessionLocator }>
  | BaseRequest<"close", Record<string, never>>;

interface BaseRequest<Action extends string, Args> {
  version: typeof BROWSER_SESSION_PROTOCOL_VERSION;
  id: string;
  token: string;
  action: Action;
  args: Args;
}

export type BrowserSessionResult =
  | BrowserSessionStatus
  | BrowserSessionInspection
  | BrowserSessionScreenshot
  | BrowserSessionTab[]
  | BrowserSessionTab
  | { closing: true }
  | { revision: number };

export type BrowserSessionResponse =
  | {
      version: typeof BROWSER_SESSION_PROTOCOL_VERSION;
      id: string;
      ok: true;
      result: BrowserSessionResult;
    }
  | {
      version: typeof BROWSER_SESSION_PROTOCOL_VERSION;
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export interface BrowserSessionTarget {
  sessionStatus(): Promise<BrowserSessionStatus>;
  sessionInspect(locator?: BrowserSessionLocator): Promise<BrowserSessionInspection>;
  sessionScreenshot(out: string): Promise<BrowserSessionScreenshot>;
  sessionTabs(): Promise<BrowserSessionTab[]>;
  sessionSelectTab(index: number): Promise<BrowserSessionTab>;
  sessionOpenTab(url: string): Promise<BrowserSessionTab>;
  sessionCloseTab(index: number): Promise<BrowserSessionTab>;
  sessionGoto(url: string): Promise<BrowserSessionTab>;
  sessionReload(): Promise<BrowserSessionTab>;
  sessionClick(locator: BrowserSessionLocator): Promise<{ revision: number }>;
  sessionFill(locator: BrowserSessionLocator, value: string): Promise<{ revision: number }>;
  sessionPress(key: string): Promise<{ revision: number }>;
  sessionWait(locator: BrowserSessionLocator): Promise<{ revision: number }>;
}

export class BrowserSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserSessionError";
  }
}

export interface BrowserSessionServer {
  descriptorPath: string;
  closeRequested: Promise<void>;
  stopAccepting(): Promise<void>;
  cleanup(): Promise<void>;
}

interface StartOptions {
  platform?: NodeJS.Platform;
  actionTimeoutMs?: number;
  shortActionTimeoutMs?: number;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

export function browserSessionTransport(
  controlFile: string,
  platform: NodeJS.Platform = process.platform,
): BrowserSessionDescriptor["transport"] {
  if (platform === "win32") {
    return {
      kind: "pipe",
      address: `\\\\.\\pipe\\harnery-browser-${randomUUID()}`,
    };
  }
  const address = `${controlFile}.${randomBytes(8).toString("hex")}.sock`;
  if (Buffer.byteLength(address) > UNIX_SOCKET_MAX_BYTES) {
    throw new BrowserSessionError(
      "socket_path_too_long",
      `Control file path is too long for a Unix socket; keep it under ${UNIX_SOCKET_MAX_BYTES - 23} bytes.`,
    );
  }
  return { kind: "unix", address };
}

export async function startBrowserSessionServer(
  controlFileInput: string,
  target: BrowserSessionTarget,
  options: StartOptions = {},
): Promise<BrowserSessionServer> {
  const controlFile = resolve(controlFileInput);
  const platform = options.platform ?? process.platform;
  assertPrivateParent(controlFile, platform);
  if (existsSync(controlFile)) {
    throw new BrowserSessionError(
      "descriptor_exists",
      `Control descriptor already exists at ${controlFile}. Inspect or remove the stale file first.`,
    );
  }

  const transport = browserSessionTransport(controlFile, platform);
  if (transport.kind === "unix" && existsSync(transport.address)) {
    throw new BrowserSessionError(
      "transport_exists",
      "Control transport already exists. Remove the stale endpoint first.",
    );
  }

  const token = randomBytes(32).toString("base64url");
  const descriptor: BrowserSessionDescriptor = {
    version: BROWSER_SESSION_PROTOCOL_VERSION,
    pid: process.pid,
    created_at: new Date().toISOString(),
    transport,
    token,
  };
  const closeSignal = deferred();
  const sockets = new Set<Socket>();
  const actionSockets = new Set<Socket>();
  let accepting = true;
  let cleaned = false;
  let published = false;
  let actionTail: Promise<void> = Promise.resolve();

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      actionSockets.delete(socket);
    });
    readRequestFrame(socket)
      .then(async (raw) => {
        const parsed = parseBrowserSessionRequest(raw);
        if (!tokenMatches(token, parsed.token)) {
          return errorResponse(parsed.id, "auth_failed", "Session authentication failed.");
        }
        if (!accepting) {
          return errorResponse(parsed.id, "session_closing", "Browser session is closing.");
        }
        actionSockets.add(socket);

        let actionPromise!: Promise<BrowserSessionResult>;
        actionPromise = actionTail.then(() => dispatchAction(parsed, target, closeSignal));
        actionTail = actionPromise.then(
          () => undefined,
          () => undefined,
        );
        const timeoutMs = isShortAction(parsed.action)
          ? (options.shortActionTimeoutMs ?? SHORT_ACTION_TIMEOUT_MS)
          : (options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);
        try {
          const result = await responseWithTimeout(actionPromise, timeoutMs);
          return successResponse(parsed.id, result);
        } catch (error) {
          return safeActionError(parsed.id, error);
        }
      })
      .catch((error) => {
        const safe =
          error instanceof BrowserSessionError
            ? errorResponse("unknown", error.code, error.message)
            : errorResponse("unknown", "invalid_request", "Invalid browser-session request.");
        return safe;
      })
      .then((response) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
        actionSockets.delete(socket);
      })
      .catch(() => socket.destroy());
  });

  try {
    server.listen(transport.address);
    await once(server, "listening");
    if (transport.kind === "unix") chmodSync(transport.address, 0o600);
    publishDescriptor(controlFile, descriptor);
    published = true;
  } catch (error) {
    await closeServer(server);
    if (transport.kind === "unix") unlinkIfExists(transport.address);
    throw error;
  }

  async function stopAccepting(): Promise<void> {
    if (!accepting) return;
    accepting = false;
    const serverClosed = closeServer(server);
    for (const socket of sockets) {
      if (!actionSockets.has(socket)) socket.destroy();
    }
    const settled = await settlesWithin(
      actionTail,
      options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
    );
    if (!settled) {
      for (const socket of sockets) socket.destroy();
    }
    await serverClosed;
  }

  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    await stopAccepting();
    for (const socket of sockets) socket.destroy();
    if (published) unlinkIfExists(controlFile);
    if (transport.kind === "unix") unlinkIfExists(transport.address);
  }

  return {
    descriptorPath: controlFile,
    closeRequested: closeSignal.promise,
    stopAccepting,
    cleanup,
  };
}

export function readBrowserSessionDescriptor(
  controlFileInput: string,
  platform: NodeJS.Platform = process.platform,
): BrowserSessionDescriptor {
  const controlFile = resolve(controlFileInput);
  assertPrivateParent(controlFile, platform);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(controlFile);
  } catch {
    throw new BrowserSessionError(
      "descriptor_missing",
      "Browser session descriptor was not found.",
    );
  }
  if (!stat.isFile()) {
    throw new BrowserSessionError(
      "descriptor_invalid",
      "Browser session descriptor is not a file.",
    );
  }
  if (platform !== "win32") {
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) {
      throw new BrowserSessionError(
        "descriptor_owner",
        "Browser session descriptor is not owned by the current user.",
      );
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new BrowserSessionError(
        "descriptor_mode",
        "Browser session descriptor must have mode 0600.",
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(controlFile, "utf8"));
  } catch {
    throw new BrowserSessionError("descriptor_invalid", "Browser session descriptor is invalid.");
  }
  return validateDescriptor(parsed);
}

export async function sendBrowserSessionRequest(
  controlFile: string,
  action: BrowserSessionRequest["action"],
  args: Record<string, unknown>,
): Promise<BrowserSessionResult> {
  const descriptor = readBrowserSessionDescriptor(controlFile);
  const request = parseBrowserSessionRequest({
    version: BROWSER_SESSION_PROTOCOL_VERSION,
    id: randomUUID(),
    token: descriptor.token,
    action,
    args,
  });
  const response = await sendRequestToDescriptor(descriptor, request);
  if (!response.ok) throw new BrowserSessionError(response.error.code, response.error.message);
  return response.result;
}

export async function sendRequestToDescriptor(
  descriptor: BrowserSessionDescriptor,
  request: BrowserSessionRequest,
): Promise<BrowserSessionResponse> {
  const socket = createConnection(descriptor.transport.address);
  try {
    await once(socket, "connect");
    socket.write(`${JSON.stringify(request)}\n`);
    const raw = await readResponseFrame(socket);
    return parseBrowserSessionResponse(raw, request.id);
  } catch (error) {
    socket.destroy();
    if (error instanceof BrowserSessionError) throw error;
    throw new BrowserSessionError("transport_failed", "Could not connect to the browser session.");
  }
}

export function parseBrowserSessionRequest(value: unknown): BrowserSessionRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "id", "token", "action", "args"])) {
    throw new BrowserSessionError("invalid_request", "Invalid browser-session request.");
  }
  if (value.version !== BROWSER_SESSION_PROTOCOL_VERSION) {
    throw new BrowserSessionError("unsupported_version", "Unsupported browser-session protocol.");
  }
  const id = requiredString(value.id, "id", 128);
  const token = requiredString(value.token, "token", 128);
  const action = requiredString(value.action, "action", 32);
  if (!isRecord(value.args)) {
    throw new BrowserSessionError("invalid_request", "Request args must be an object.");
  }

  const base = { version: BROWSER_SESSION_PROTOCOL_VERSION, id, token };
  switch (action) {
    case "status":
    case "tabs":
    case "reload":
    case "close":
      requireKeys(value.args, []);
      return { ...base, action, args: {} };
    case "inspect": {
      requireKeys(value.args, ["locator"], true);
      return {
        ...base,
        action,
        args: value.args.locator === undefined ? {} : { locator: parseLocator(value.args.locator) },
      };
    }
    case "screenshot":
      requireKeys(value.args, ["out"]);
      return { ...base, action, args: { out: requiredString(value.args.out, "out", 4096) } };
    case "select_tab":
    case "close_tab":
      requireKeys(value.args, ["index"]);
      return { ...base, action, args: { index: requiredIndex(value.args.index) } };
    case "open_tab":
    case "goto":
      requireKeys(value.args, ["url"]);
      return { ...base, action, args: { url: requiredString(value.args.url, "url", 8192) } };
    case "click":
    case "wait":
      requireKeys(value.args, ["locator"]);
      return { ...base, action, args: { locator: parseLocator(value.args.locator) } };
    case "fill": {
      requireKeys(value.args, ["locator", "value"]);
      const fillValue = requiredString(value.args.value, "value", BROWSER_SESSION_MAX_FILL_BYTES);
      if (Buffer.byteLength(fillValue) > BROWSER_SESSION_MAX_FILL_BYTES) {
        throw new BrowserSessionError("fill_too_large", "Fill input exceeds the 64 KiB limit.");
      }
      return {
        ...base,
        action,
        args: { locator: parseLocator(value.args.locator), value: fillValue },
      };
    }
    case "press":
      requireKeys(value.args, ["key"]);
      return { ...base, action, args: { key: requiredString(value.args.key, "key", 128) } };
    default:
      throw new BrowserSessionError("unknown_action", "Unknown browser-session action.");
  }
}

function parseLocator(value: unknown): BrowserSessionLocator {
  if (!isRecord(value)) {
    throw new BrowserSessionError("invalid_locator", "A locator object is required.");
  }
  const kind = requiredString(value.kind, "locator kind", 16);
  const partial = value.partial === undefined ? false : requiredBoolean(value.partial);
  if (kind === "selector") {
    requireKeys(value, ["kind", "value", "partial"] as const, true);
    return { kind, value: requiredString(value.value, "selector", 4096), partial };
  }
  if (kind === "role") {
    requireKeys(value, ["kind", "value", "name", "partial"] as const, true);
    const role = requiredString(value.value, "role", 64);
    if (!ARIA_ROLES.has(role)) {
      throw new BrowserSessionError("invalid_locator", "Unsupported accessible role.");
    }
    return {
      kind,
      value: role,
      ...(value.name === undefined ? {} : { name: requiredString(value.name, "name", 4096) }),
      partial,
    };
  }
  if (kind === "label" || kind === "text") {
    requireKeys(value, ["kind", "value", "partial"] as const, true);
    return { kind, value: requiredString(value.value, kind, 4096), partial };
  }
  throw new BrowserSessionError("invalid_locator", "Unsupported locator kind.");
}

async function dispatchAction(
  request: BrowserSessionRequest,
  target: BrowserSessionTarget,
  closeSignal: Deferred,
): Promise<BrowserSessionResult> {
  switch (request.action) {
    case "status":
      return target.sessionStatus();
    case "inspect":
      return target.sessionInspect(request.args.locator);
    case "screenshot":
      return target.sessionScreenshot(request.args.out);
    case "tabs":
      return target.sessionTabs();
    case "select_tab":
      return target.sessionSelectTab(request.args.index);
    case "open_tab":
      return target.sessionOpenTab(request.args.url);
    case "close_tab":
      return target.sessionCloseTab(request.args.index);
    case "goto":
      return target.sessionGoto(request.args.url);
    case "reload":
      return target.sessionReload();
    case "click":
      return target.sessionClick(request.args.locator);
    case "fill":
      return target.sessionFill(request.args.locator, request.args.value);
    case "press":
      return target.sessionPress(request.args.key);
    case "wait":
      return target.sessionWait(request.args.locator);
    case "close":
      closeSignal.resolve();
      return { closing: true };
  }
}

function publishDescriptor(path: string, descriptor: BrowserSessionDescriptor): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    linkSync(temporary, path);
  } catch (error) {
    if (existsSync(path)) {
      throw new BrowserSessionError(
        "descriptor_exists",
        `Control descriptor already exists at ${path}. Inspect or remove the stale file first.`,
      );
    }
    throw error;
  } finally {
    unlinkIfExists(temporary);
  }
}

function assertPrivateParent(path: string, platform: NodeJS.Platform): void {
  const parent = dirname(path);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(parent);
  } catch {
    throw new BrowserSessionError(
      "parent_missing",
      "Control descriptor parent directory must already exist.",
    );
  }
  if (!stat.isDirectory()) {
    throw new BrowserSessionError(
      "parent_invalid",
      "Control descriptor parent is not a directory.",
    );
  }
  if (platform === "win32") return;
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new BrowserSessionError(
      "parent_owner",
      "Control descriptor directory is not owned by the current user.",
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new BrowserSessionError(
      "parent_mode",
      "Control descriptor directory must not be accessible by group or other users.",
    );
  }
}

async function readRequestFrame(socket: Socket): Promise<unknown> {
  const text = await readFrame(socket, BROWSER_SESSION_MAX_FRAME_BYTES, "request");
  try {
    return JSON.parse(text);
  } catch {
    throw new BrowserSessionError("malformed_json", "Request frame is not valid JSON.");
  }
}

async function readResponseFrame(socket: Socket): Promise<unknown> {
  const text = await readFrame(socket, BROWSER_SESSION_MAX_FRAME_BYTES, "response");
  try {
    return JSON.parse(text);
  } catch {
    throw new BrowserSessionError("invalid_response", "Browser session returned invalid JSON.");
  }
}

async function readFrame(
  socket: Socket,
  limit: number,
  kind: "request" | "response",
): Promise<string> {
  return await new Promise<string>((resolveFrame, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > limit) {
        fail(
          new BrowserSessionError("frame_too_large", `${capitalize(kind)} frame exceeds 1 MiB.`),
        );
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const trailing = buffer
        .subarray(newline + 1)
        .toString("utf8")
        .trim();
      if (trailing.length > 0) {
        fail(
          new BrowserSessionError("multiple_frames", "Only one frame is allowed per connection."),
        );
        return;
      }
      settled = true;
      resolveFrame(buffer.subarray(0, newline).toString("utf8"));
    });
    socket.once("end", () => {
      if (!settled) {
        fail(
          new BrowserSessionError(
            "unterminated_frame",
            `${capitalize(kind)} frame is unterminated.`,
          ),
        );
      }
    });
    socket.once("error", (error) => fail(error));
  });
}

function parseBrowserSessionResponse(value: unknown, requestId: string): BrowserSessionResponse {
  if (
    !isRecord(value) ||
    value.version !== BROWSER_SESSION_PROTOCOL_VERSION ||
    value.id !== requestId
  ) {
    throw new BrowserSessionError(
      "invalid_response",
      "Browser session returned an invalid response.",
    );
  }
  if (value.ok === true && "result" in value) {
    return value as BrowserSessionResponse;
  }
  if (
    value.ok === false &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  ) {
    return value as BrowserSessionResponse;
  }
  throw new BrowserSessionError(
    "invalid_response",
    "Browser session returned an invalid response.",
  );
}

function validateDescriptor(value: unknown): BrowserSessionDescriptor {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "pid", "created_at", "transport", "token"])
  ) {
    throw new BrowserSessionError("descriptor_invalid", "Browser session descriptor is invalid.");
  }
  if (
    value.version !== BROWSER_SESSION_PROTOCOL_VERSION ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.created_at !== "string" ||
    Number.isNaN(Date.parse(value.created_at)) ||
    typeof value.token !== "string" ||
    value.token.length < 40 ||
    !isRecord(value.transport) ||
    !hasOnlyKeys(value.transport, ["kind", "address"]) ||
    (value.transport.kind !== "unix" && value.transport.kind !== "pipe") ||
    typeof value.transport.address !== "string" ||
    value.transport.address.length === 0
  ) {
    throw new BrowserSessionError("descriptor_invalid", "Browser session descriptor is invalid.");
  }
  return value as unknown as BrowserSessionDescriptor;
}

function tokenMatches(expected: string, actual: string): boolean {
  const expectedHash = createHash("sha256").update(expected).digest();
  const actualHash = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

function successResponse(id: string, result: BrowserSessionResult): BrowserSessionResponse {
  return { version: BROWSER_SESSION_PROTOCOL_VERSION, id, ok: true, result };
}

function errorResponse(id: string, code: string, message: string): BrowserSessionResponse {
  return { version: BROWSER_SESSION_PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}

function safeActionError(id: string, error: unknown): BrowserSessionResponse {
  if (error instanceof BrowserSessionError) return errorResponse(id, error.code, error.message);
  if (
    isRecord(error) &&
    error.name === "BrowserSessionActionError" &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return errorResponse(id, error.code, error.message);
  }
  return errorResponse(id, "action_failed", "Browser action failed.");
}

function responseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new BrowserSessionError("action_timeout", "Browser action timed out.")),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isShortAction(action: BrowserSessionRequest["action"]): boolean {
  return action === "status" || action === "tabs" || action === "close";
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new BrowserSessionError("invalid_request", `Invalid ${field}.`);
  }
  return value;
}

function requiredIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BrowserSessionError("invalid_request", "Tab index must be a non-negative integer.");
  }
  return value as number;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new BrowserSessionError("invalid_request", "Locator partial flag must be boolean.");
  }
  return value;
}

function requireKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): void {
  if (!hasOnlyKeys(value, keys)) {
    throw new BrowserSessionError("invalid_request", "Request args contain unsupported fields.");
  }
  if (!optional && keys.some((key) => !(key in value))) {
    throw new BrowserSessionError("invalid_request", "Request args are incomplete.");
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
