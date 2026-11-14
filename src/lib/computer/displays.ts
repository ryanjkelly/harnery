/**
 * Display detection and agent-window placement for `harn computer` (ADR 0251).
 *
 * Internal module: not exported from package.json.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { windowsExecutable } from "../windows-executable.ts";
import { defaultSpawnSync, normalize, type SpawnSyncFn } from "./driver-support.ts";
import type { Corner } from "./placement.ts";
import type { DisplayInfo, HostInfo, Rect } from "./types.ts";

/** One reading of the desktop's displays. */
export interface DisplaySnapshot {
  probed_at: string;
  /** Which probe answered: "windows", "macos", "linux-xrandr", "driver", … */
  source: string;
  displays: DisplayInfo[];
  /** Why no probe answered, when `displays` is empty. */
  error?: string;
}

export interface DisplayProbeDeps {
  spawnSync?: SpawnSyncFn;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Fallback: the displays a desktop driver reports, or undefined when none can. */
  driverDisplays?: () => DisplayInfo[] | undefined;
}

export {
  CORNERS,
  type Corner,
  DEFAULT_PLACEMENT,
  SMALLEST_REQUEST,
  type WindowPlacement,
} from "./placement.ts";

/**
 * Lists every screen with its true pixel bounds, work area and scale. The
 * process opts into per-monitor DPI awareness first so the numbers are
 * physical pixels, the space window frames use on Windows.
 */
const WINDOWS_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  'Add-Type -Namespace H -Name D -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr c); [DllImport("user32.dll")] public static extern System.IntPtr MonitorFromPoint(System.Drawing.Point p, uint f); [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(System.IntPtr m, int t, out uint x, out uint y);\' -ReferencedAssemblies System.Drawing',
  "[void][H.D]::SetProcessDpiAwarenessContext([IntPtr](-4))",
  "$out = foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {",
  "  $dx = 96; $dy = 96",
  "  $px = $s.Bounds.X + 1; $py = $s.Bounds.Y + 1",
  "  $m = [H.D]::MonitorFromPoint((New-Object System.Drawing.Point $px, $py), 2)",
  "  [void][H.D]::GetDpiForMonitor($m, 0, [ref]$dx, [ref]$dy)",
  "  [pscustomobject]@{ id = $s.DeviceName; primary = $s.Primary; scale = [math]::Round($dx / 96, 2)",
  "    bounds = @{ x = $s.Bounds.X; y = $s.Bounds.Y; width = $s.Bounds.Width; height = $s.Bounds.Height }",
  "    work_area = @{ x = $s.WorkingArea.X; y = $s.WorkingArea.Y; width = $s.WorkingArea.Width; height = $s.WorkingArea.Height } }",
  "}",
  "ConvertTo-Json @($out) -Depth 4 -Compress",
].join("\n");

/** AppKit screens as raw JSON; the coordinate flip happens in TypeScript. */
const MACOS_SCRIPT = [
  "ObjC.import('AppKit');",
  "var out = [];",
  "var screens = $.NSScreen.screens;",
  "for (var i = 0; i < screens.count; i++) {",
  "  var s = screens.objectAtIndex(i);",
  "  var f = s.frame; var v = s.visibleFrame;",
  "  var n = s.deviceDescription.objectForKey('NSScreenNumber');",
  "  out.push({ id: n ? String(n.intValue) : String(i + 1),",
  "    name: s.localizedName ? ObjC.unwrap(s.localizedName) : '',",
  "    scale: s.backingScaleFactor,",
  "    frame: { x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height },",
  "    visible: { x: v.origin.x, y: v.origin.y, width: v.size.width, height: v.size.height } });",
  "}",
  "JSON.stringify(out);",
].join("\n");

const PROBE_TIMEOUT_MS = 30_000;

type NativeResult = { displays: DisplayInfo[]; error?: string };

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toRect(value: unknown): Rect | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  const x = num(r.x);
  const y = num(r.y);
  const width = num(r.width);
  const height = num(r.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

function parseJsonText(stdout: string | undefined): unknown {
  const text = normalize(stdout)
    .replace(/^\uFEFF/, "")
    .trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === "object" ? [value] : [];
}

function failure(command: string, result: ReturnType<SpawnSyncFn>): string {
  if (result.error) return `${command} could not run: ${result.error.message}`;
  const detail = normalize(result.stderr).trim().split("\n")[0] ?? "";
  return `${command} exited ${result.status ?? "abnormally"}${detail ? `: ${detail}` : ""}`;
}

function run(deps: DisplayProbeDeps, command: string, args: string[]) {
  const spawn = deps.spawnSync ?? defaultSpawnSync;
  try {
    return spawn(command, args, { timeout: PROBE_TIMEOUT_MS, env: deps.env ?? process.env });
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error: error as Error };
  }
}

function probeWindows(deps: DisplayProbeDeps): NativeResult {
  const result = run(deps, windowsExecutable("powershell.exe"), [
    "-NoProfile",
    "-Command",
    WINDOWS_SCRIPT,
  ]);
  if (result.error || result.status !== 0)
    return { displays: [], error: failure("powershell.exe", result) };
  const displays: DisplayInfo[] = [];
  for (const item of asList(parseJsonText(result.stdout))) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const bounds = toRect(raw.bounds);
    if (typeof raw.id !== "string" || !bounds) continue;
    const display: DisplayInfo = { id: raw.id, primary: raw.primary === true, bounds };
    const workArea = toRect(raw.work_area);
    if (workArea) display.work_area = workArea;
    const scale = num(raw.scale);
    if (scale && scale > 0) display.scale = scale;
    displays.push(display);
  }
  return displays.length > 0
    ? { displays }
    : { displays: [], error: "powershell.exe reported no displays" };
}

/** AppKit's origin is the primary screen's bottom-left; window frames use its top-left. */
function flip(rect: Rect, primaryHeight: number): Rect {
  return {
    x: Math.round(rect.x),
    y: Math.round(primaryHeight - (rect.y + rect.height)),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function probeMacos(deps: DisplayProbeDeps): NativeResult {
  const result = run(deps, "osascript", ["-l", "JavaScript", "-e", MACOS_SCRIPT]);
  if (result.error || result.status !== 0)
    return { displays: [], error: failure("osascript", result) };
  const screens: { id: string; name?: string; scale?: number; frame: Rect; visible?: Rect }[] = [];
  for (const item of asList(parseJsonText(result.stdout))) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const frame = toRect(raw.frame);
    if (!frame) continue;
    const id = typeof raw.id === "string" && raw.id ? raw.id : String(screens.length + 1);
    screens.push({
      id,
      name: typeof raw.name === "string" && raw.name ? raw.name : undefined,
      scale: num(raw.scale),
      frame,
      visible: toRect(raw.visible),
    });
  }
  if (screens.length === 0) return { displays: [], error: "osascript reported no displays" };
  const primary = screens.find((s) => s.frame.x === 0 && s.frame.y === 0) ?? screens[0];
  const primaryHeight = primary?.frame.height ?? 0;
  const displays = screens.map((s) => {
    const display: DisplayInfo = {
      id: s.id,
      primary: s === primary,
      bounds: flip(s.frame, primaryHeight),
    };
    if (s.name) display.name = s.name;
    if (s.visible) display.work_area = flip(s.visible, primaryHeight);
    if (s.scale && s.scale > 0) display.scale = s.scale;
    return display;
  });
  return { displays };
}

const XRANDR_LINE = /^(\S+) connected(?: (primary))? (\d+)x(\d+)([+-]\d+)([+-]\d+)/;

function probeXrandr(deps: DisplayProbeDeps): NativeResult {
  const result = run(deps, "xrandr", ["--query"]);
  if (result.error || result.status !== 0)
    return { displays: [], error: failure("xrandr", result) };
  const displays: DisplayInfo[] = [];
  for (const line of normalize(result.stdout).split("\n")) {
    const m = XRANDR_LINE.exec(line);
    if (!m) continue;
    const [, id, primary, w, h, x, y] = m;
    if (!id || !w || !h || !x || !y) continue;
    displays.push({
      id,
      primary: primary === "primary",
      bounds: { x: Number(x), y: Number(y), width: Number(w), height: Number(h) },
    });
  }
  return displays.length > 0
    ? { displays }
    : { displays: [], error: "xrandr reported no connected displays" };
}

function fromDriver(deps: DisplayProbeDeps): NativeResult {
  if (!deps.driverDisplays) return { displays: [], error: "no driver can list displays" };
  try {
    const displays = deps.driverDisplays() ?? [];
    return displays.length > 0
      ? { displays }
      : { displays: [], error: "the driver reported no displays" };
  } catch (error) {
    return {
      displays: [],
      error: `the driver's display listing failed: ${(error as Error).message}`,
    };
  }
}

/** Read the displays now. Never throws: an empty `displays` carries `error`. */
export function probeDisplays(host: HostInfo, deps: DisplayProbeDeps = {}): DisplaySnapshot {
  const probed_at = new Date((deps.now ?? Date.now)()).toISOString();
  const probes: [string, () => NativeResult][] = [];
  const driver: [string, () => NativeResult] = ["driver", () => fromDriver(deps)];
  switch (host.kind) {
    case "windows":
    case "wsl":
      probes.push(["windows", () => probeWindows(deps)], driver);
      break;
    case "macos":
      probes.push(driver, ["macos", () => probeMacos(deps)]);
      break;
    case "linux":
      probes.push(driver, ["linux-xrandr", () => probeXrandr(deps)]);
      break;
    default:
      return {
        probed_at,
        source: "none",
        displays: [],
        error: host.reason ?? "this host has no supported desktop",
      };
  }
  const errors: string[] = [];
  for (const [source, probe] of probes) {
    let result: NativeResult;
    try {
      result = probe();
    } catch (error) {
      result = { displays: [], error: (error as Error).message };
    }
    if (result.displays.length > 0) return { probed_at, source, displays: result.displays };
    if (result.error) errors.push(result.error);
  }
  return {
    probed_at,
    source: "none",
    displays: [],
    error: errors.join("; ") || "no probe reported displays",
  };
}

const CACHE_FILE = "displays.json";

function validDisplay(value: unknown): value is DisplayInfo {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "string" && typeof d.primary === "boolean" && toRect(d.bounds) !== undefined
  );
}

/** The last snapshot written to `<dir>/displays.json`, or null. */
export function readDisplayCache(dir: string): DisplaySnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, CACHE_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const s = parsed as Record<string, unknown>;
  if (typeof s.probed_at !== "string" || typeof s.source !== "string" || !Array.isArray(s.displays))
    return null;
  if (!s.displays.every(validDisplay)) return null;
  const snapshot: DisplaySnapshot = {
    probed_at: s.probed_at,
    source: s.source,
    displays: s.displays,
  };
  if (typeof s.error === "string") snapshot.error = s.error;
  return snapshot;
}

export function writeDisplayCache(dir: string, snapshot: DisplaySnapshot): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, CACHE_FILE);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
  renameSync(tmp, target);
}

function ordered(displays: DisplayInfo[]): DisplayInfo[] {
  return [...displays].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

/**
 * The display a placement names. "secondary" falls back to the primary (or
 * only) display on a one-display desktop; an unknown id or index is undefined.
 */
export function pickDisplay(displays: DisplayInfo[], selector: string): DisplayInfo | undefined {
  if (displays.length === 0) return undefined;
  const list = ordered(displays);
  const wanted = selector.trim();
  if (wanted === "primary") return list.find((d) => d.primary) ?? list[0];
  if (wanted === "secondary") return list.find((d) => !d.primary) ?? list[0];
  if (/^\d+$/.test(wanted)) {
    const index = Number(wanted);
    return index >= 1 ? list[index - 1] : undefined;
  }
  const exact = list.find((d) => d.id === wanted);
  if (exact) return exact;
  const lower = wanted.toLowerCase();
  return list.find((d) => d.id.toLowerCase() === lower || d.name?.toLowerCase() === lower);
}

/** The top-left position that puts a window of `size` in `corner` of the display's work area. */
export function cornerPosition(
  display: DisplayInfo,
  corner: Corner,
  size: { width: number; height: number },
  margin: number,
): { x: number; y: number } {
  const area = display.work_area ?? display.bounds;
  const right = corner === "top-right" || corner === "bottom-right";
  const bottom = corner === "bottom-left" || corner === "bottom-right";
  let x = right ? area.x + area.width - size.width - margin : area.x + margin;
  let y = bottom ? area.y + area.height - size.height - margin : area.y + margin;
  x = Math.max(area.x, Math.min(x, area.x + area.width - 1));
  y = Math.max(area.y, Math.min(y, area.y + area.height - 1));
  return { x: Math.round(x), y: Math.round(y) };
}

/** A short plain-language line per display, for status and the displays command. */
export function describeDisplay(display: DisplayInfo): string {
  const { x, y, width, height } = display.bounds;
  const label = display.name ? `${display.name} (${display.id})` : display.id;
  let line = `${label}: ${width} by ${height} at (${x}, ${y})`;
  if (display.scale) line += `, ${Math.round(display.scale * 100)}% scale`;
  if (display.primary) line += ", primary";
  return line;
}

export type { DisplayInfo, Rect };
