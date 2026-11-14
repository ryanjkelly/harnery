/**
 * Pure helpers behind the Cua Driver's browser surface (ADR 0250): which
 * browser calls one driver call makes, what a browser call's result showed,
 * and the window-list parsing and script building `openBrowserWindow` and
 * `closeWindow` use. Nothing here runs a process; `cua.ts` wires it up.
 *
 * Internal module: not exported from package.json.
 */

import type { BrowserCall, BrowserObservation, WindowRef } from "./types.ts";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const int = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

/** Browser tools that change a tab without typing or pointing. */
const ACT_TOOLS: ReadonlySet<string> = new Set([
  "browser_navigate",
  "browser_select",
  "browser_dialog",
  "browser_download",
  "browser_set_input_files",
]);
const POINT_TOOLS: ReadonlySet<string> = new Set(["browser_click", "browser_pointer"]);

function entry(
  kind: BrowserCall["kind"],
  tool: string,
  session: string | undefined,
  fields: Partial<Omit<BrowserCall, "kind" | "tool" | "session">> = {},
): BrowserCall {
  const out: BrowserCall = { kind, tool };
  if (session !== undefined) out.session = session;
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) (out as unknown as Json)[key] = value;
  return out;
}

/** One `run_steps` step as `{tool, args}`; also accepts the `{"<tool>": {...args}}` form. */
function stepCall(step: unknown): { tool: string; args: Json; session?: string } | undefined {
  if (!isRecord(step)) return undefined;
  if (typeof step.tool === "string") {
    const out: { tool: string; args: Json; session?: string } = {
      tool: step.tool,
      args: isRecord(step.args) ? step.args : {},
    };
    const session = str(step.session);
    if (session !== undefined) out.session = session;
    return out;
  }
  const keys = Object.keys(step);
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only !== undefined && isRecord(step[only])) return { tool: only, args: step[only] as Json };
  return undefined;
}

function classify(tool: string, args: Json, outerSession: string | undefined): BrowserCall[] {
  const session = str(args.session) ?? outerSession;
  const ids = {
    target_id: str(args.target_id),
    tab_id: str(args.tab_id),
  };
  const window = { pid: int(args.pid), window_id: int(args.window_id) };
  switch (tool) {
    case "browser_prepare":
      return [
        entry(
          isRecord(args.strategy) && args.strategy.kind === "existing_profile"
            ? "attach"
            : "launch",
          tool,
          session,
          window,
        ),
      ];
    case "get_browser_state":
      return [
        ids.target_id !== undefined
          ? entry("read", tool, session, ids)
          : entry("bind", tool, session, window),
      ];
    case "browser_type":
      return [entry("type", tool, session, { ...ids, ref: str(args.ref) })];
    case "page":
      return [entry("opaque", tool, session)];
    case "run_steps": {
      const steps = Array.isArray(args.steps) ? args.steps : [];
      return steps.flatMap((step) => {
        const call = stepCall(step);
        return call ? classify(call.tool, call.args, call.session ?? session) : [];
      });
    }
    case "run_script":
      return typeof args.script === "string" && args.script.includes("browser_")
        ? [entry("opaque", tool, session)]
        : [];
  }
  if (POINT_TOOLS.has(tool)) return [entry("point", tool, session, { ...ids, ref: str(args.ref) })];
  if (ACT_TOOLS.has(tool))
    return [
      entry("act", tool, session, {
        ...ids,
        ref: str(args.ref),
        ...(tool === "browser_navigate" ? { navigates: true } : {}),
      }),
    ];
  return [];
}

/**
 * The browser calls inside one Cua Driver call: the call itself, each step of
 * `run_steps`, or one `opaque` entry for a `run_script` program that names a
 * browser tool. Empty when the call touches no browser.
 */
export function cuaBrowserCalls(tool: string, args: Record<string, unknown>): BrowserCall[] {
  return classify(tool, args, undefined);
}

/**
 * A field label or name that asks for a secret: a password, passcode,
 * passphrase, PIN, one-time or verification code, OTP or 2FA code.
 */
export const SENSITIVE_FIELD_PATTERN =
  /pass(?:word|code|phrase)|\bpin\b|one[-_ ]?time[-_ ]?(?:pass)?code|\botp\b|\b2fa\b|two[-_ ]?factor|(?:verification|security|auth(?:entication)?) code|type=password|autocomplete=(?:one-time-code|current-password|new-password)/i;

/** A password manager by name, or a save, update or fill-password offer. */
export const PASSWORD_OFFER_PATTERN =
  /\b(?:1password|bitwarden|lastpass|dashlane|keeper|nordpass|proton ?pass)\b|\b(?:save|update|fill|use|suggest(?:ed)?)\s+(?:(?:a|the|this|your|strong|saved)\s+)*password\b/i;

const EDITABLE_ROLES = /^(?:textbox|searchbox|combobox|spinbutton|textfield|text field)$/i;
const EDITABLE_NODES = /^(?:input|textarea|select)$/i;

interface RefInfo {
  ref?: string;
  editable: boolean;
  text: string;
}

function refInfo(value: unknown): RefInfo | undefined {
  if (!isRecord(value)) return undefined;
  const actions = Array.isArray(value.actions) ? value.actions : [];
  const states = isRecord(value.states) ? value.states : {};
  const label = String(value.label ?? "");
  const nonText = /\btype=(?:checkbox|radio|button|submit|reset|hidden|image)\b/i.test(label);
  const editable =
    !nonText &&
    (actions.includes("type") ||
      (states.editable !== undefined && states.editable !== false) ||
      (typeof value.role === "string" && EDITABLE_ROLES.test(value.role)) ||
      (typeof value.node === "string" && EDITABLE_NODES.test(value.node)) ||
      /\bcontenteditable\b/i.test(label));
  const text = [value.name, value.label].filter((v) => typeof v === "string").join(" ");
  const info: RefInfo = { editable, text };
  const ref = str(value.ref);
  if (ref !== undefined) info.ref = ref;
  return info;
}

function snapshotOf(
  result: Json,
  call: BrowserCall,
): NonNullable<BrowserObservation["snapshot"]> | undefined {
  const target_id = str(result.target_id) ?? call.target_id;
  const tab_id = str(result.tab_id) ?? call.tab_id;
  if (target_id === undefined || tab_id === undefined) return undefined;
  const refs = [
    ...(Array.isArray(result.refs) ? result.refs : []),
    ...(Array.isArray(result.content_refs) ? result.content_refs : []),
  ]
    .map(refInfo)
    .filter((r): r is RefInfo => r !== undefined);
  const sensitive = new Set<string>();
  for (const r of refs)
    if (r.ref !== undefined && r.editable && SENSITIVE_FIELD_PATTERN.test(r.text))
      sensitive.add(r.ref);
  const outline = typeof result.outline === "string" ? result.outline : "";
  const password_offer =
    refs.some((r) => PASSWORD_OFFER_PATTERN.test(r.text)) || PASSWORD_OFFER_PATTERN.test(outline);
  return { target_id, tab_id, sensitive_refs: [...sensitive], password_offer };
}

/** What one browser call's stdout showed. Output that is not a JSON object shows nothing. */
export function cuaBrowserObservation(call: BrowserCall, stdout: string): BrowserObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const refused =
    parsed.status === "refused" || parsed.refusal !== undefined || typeof parsed.code === "string";
  switch (call.kind) {
    case "bind": {
      const target_id = str(parsed.target_id);
      if (refused || target_id === undefined || (parsed.status ?? "ok") !== "ok") return {};
      const bound: NonNullable<BrowserObservation["bound"]> = { target_id };
      if (call.pid !== undefined) bound.pid = call.pid;
      if (call.window_id !== undefined) bound.window_id = call.window_id;
      return { bound };
    }
    case "launch": {
      if (refused) return {};
      const pid = int(parsed.prepared_pid) ?? int(parsed.browser_pid) ?? int(parsed.pid);
      return pid === undefined ? {} : { launched_pid: pid };
    }
    case "read": {
      if (refused) return {};
      const snapshot = snapshotOf(parsed, call);
      return snapshot ? { snapshot } : {};
    }
    case "type":
    case "point":
    case "act":
      return { delivered: !refused && (isRecord(parsed.delivery) || parsed.status === "ok") };
    default:
      return {};
  }
}

/** One record of the driver's `list_windows` result. */
export interface ListedWindow {
  pid: number;
  window_id: number;
  app_name: string;
  z_index: number | null;
}

/** The windows in a `list_windows` result (`{"windows": [...]}` or a bare array). */
export function parseWindowList(stdout: string): ListedWindow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.windows)
      ? parsed.windows
      : [];
  const out: ListedWindow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const pid = int(row.pid);
    const window_id = int(row.window_id);
    if (pid === undefined || window_id === undefined) continue;
    out.push({
      pid,
      window_id,
      app_name: typeof row.app_name === "string" ? row.app_name : "",
      z_index: int(row.z_index) ?? null,
    });
  }
  return out;
}

/** App names of the Chromium browsers the driver can attach to: Chrome, Chromium, Edge, Brave. */
export const SUPPORTED_BROWSER_APP = /\b(?:chrome|chromium|msedge|microsoft[- ]edge|brave)\b/i;

/**
 * The pid of the person's front-most supported browser: the highest
 * `z_index` among its windows. When no window reports a stacking order, a
 * single browser process is still unambiguous; several are refused.
 */
export function pickFrontBrowser(windows: ListedWindow[]): number {
  const browsers = windows.filter((w) => SUPPORTED_BROWSER_APP.test(w.app_name));
  if (browsers.length === 0)
    throw new Error(
      "No window of a supported browser (Chrome, Chromium, Edge or Brave) is open; open the browser first or pass its pid.",
    );
  let front: ListedWindow | undefined;
  for (const w of browsers)
    if (w.z_index !== null && (front === undefined || w.z_index > (front.z_index ?? -Infinity)))
      front = w;
  if (front) return front.pid;
  const pids = new Set(browsers.map((w) => w.pid));
  if (pids.size === 1) return browsers[0]?.pid as number;
  throw new Error(
    `Several browser processes are open (${[...pids].join(", ")}) and the window stacking order is unknown; pass the browser's pid.`,
  );
}

/** PowerShell that prints the Windows default-browser association for https links (e.g. `ChromeHTML`). */
export const DEFAULT_BROWSER_SCRIPT =
  "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice').ProgId";

/**
 * The app-name pattern of the browser a default-browser identifier names
 * (a Windows ProgId such as `ChromeHTML`, or a Linux desktop entry such as
 * `brave-browser.desktop`), or undefined when it is not a supported browser.
 */
export function defaultBrowserPattern(identifier: string): RegExp | undefined {
  const id = identifier.trim().toLowerCase();
  if (id.includes("brave")) return /\bbrave\b/i;
  if (id.includes("edge")) return /\b(?:msedge|microsoft[- ]edge)\b/i;
  if (id.includes("chromium")) return /\bchromium\b/i;
  if (id.includes("chrome")) return /\bchrome\b/i;
  return undefined;
}

/**
 * The browser process to open a window in: the person's default browser when
 * it is running, else their front-most supported browser. The front-most one
 * alone is a poor guide, because it may be a second browser they keep for
 * other accounts.
 */
export function pickBrowser(windows: ListedWindow[], preferred?: RegExp): number {
  if (preferred) {
    const matching = windows.filter(
      (w) => SUPPORTED_BROWSER_APP.test(w.app_name) && preferred.test(w.app_name),
    );
    if (matching.length > 0) return pickFrontBrowser(matching);
  }
  return pickFrontBrowser(windows);
}

/** The URL to open, defaulting to `about:blank`; anything but http(s) or about: is refused. */
export function checkBrowserUrl(url: string | undefined): string {
  const value = url ?? "about:blank";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Not a valid URL: ${value}`);
  }
  if (!["http:", "https:", "about:"].includes(parsed.protocol))
    throw new Error(
      `Refusing to open ${parsed.protocol} URLs in the browser; only http:, https: and about: are allowed.`,
    );
  return value;
}

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** PowerShell that starts `<exe> --new-window <url>`. */
export function newWindowScript(executable: string, url: string): string {
  return `Start-Process -FilePath ${psQuote(executable)} -ArgumentList ${psQuote("--new-window")},${psQuote(url)}`;
}

function requirePositiveInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer, got ${String(value)}.`);
  return value;
}

/** PowerShell that prints the executable path of process `pid`. */
export function processPathScript(pid: number): string {
  return `(Get-Process -Id ${requirePositiveInteger("pid", pid)}).Path`;
}

/**
 * PowerShell that asks one window to close (WM_CLOSE, posted so nothing comes
 * forward) only when it still belongs to `pid`, so a reused handle is never
 * closed. Prints True when the message was posted.
 */
export function closeWindowScript(window: WindowRef): string {
  const pid = requirePositiveInteger("pid", window.pid);
  const handle = requirePositiveInteger("window_id", window.window_id);
  return (
    "Add-Type -Namespace H -Name W -MemberDefinition '" +
    '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l); ' +
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint p);' +
    "'; $p=0; " +
    `[void][H.W]::GetWindowThreadProcessId([IntPtr]${handle},[ref]$p); ` +
    `if ($p -eq ${pid}) { [H.W]::PostMessage([IntPtr]${handle},0x0010,[IntPtr]::Zero,[IntPtr]::Zero) }`
  );
}
