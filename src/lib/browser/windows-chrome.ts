import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookie } from "../cookies/client.ts";

/**
 * Sign-in through the Windows host's Google Chrome when running under WSL.
 *
 * Some sign-in flows reject every browser running inside WSL, including a
 * plain Linux Google Chrome with nothing attached: the sign-in request comes
 * back "429 Too Many Requests" while the same account signs in from the
 * Windows desktop browser without trouble. The Windows Chrome is the client
 * those flows accept, so `browse --login --plain` under WSL opens it on a
 * dedicated Windows-side profile. The person signs in there with nothing
 * attached. Afterwards the profile is reopened headless for a moment with its
 * last session restored, its cookies for the sign-in site (browser-session
 * cookies included) and its open pages on that site are read through the
 * DevTools protocol, and the cookies are merged into the shared cookie store
 * that later `browse` runs attach. The Windows profile cannot be shared with
 * Linux Chromium directly because Windows encrypts its cookie database with
 * keys only Windows can read.
 *
 * Under WSL2's default NAT networking the Windows loopback port is not
 * reachable from Linux, so the DevTools conversation runs inside a short
 * PowerShell script on the Windows side and prints the result to stdout.
 */

const WINDOWS_CHROME_CANDIDATES = [
  "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
  "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

/** Linux path of the Windows host's Google Chrome, or `undefined`. */
export function windowsChromePath(
  exists: (path: string) => boolean = existsSync,
  localAppDataLinux?: string,
): string | undefined {
  const candidates = [...WINDOWS_CHROME_CANDIDATES];
  if (localAppDataLinux)
    candidates.push(join(localAppDataLinux, "Google", "Chrome", "Application", "chrome.exe"));
  return candidates.find((candidate) => exists(candidate));
}

/** `%LOCALAPPDATA%` as a Windows path, read through cmd.exe interop. */
export function windowsLocalAppData(): string | undefined {
  const result = spawnSync("cmd.exe", ["/c", "echo %LOCALAPPDATA%"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const value = (result.stdout ?? "").replace(/\r/g, "").trim();
  return result.status === 0 && /^[A-Za-z]:\\/.test(value) ? value : undefined;
}

/** Windows-side profile used only for `--login --plain` sign-ins under WSL. */
export function windowsPlainProfile(localAppData: string): string {
  return `${localAppData}\\harnery\\plain-login-profile`;
}

/**
 * The registrable domain to harvest for a sign-in URL: the last two labels of
 * the host (`x.com` from `https://x.com/i/flow/login`). Cookies are kept when
 * their domain equals it or is a subdomain of it, so a sign-in that also sets
 * cookies for an identity provider does not copy those into the store.
 */
export function harvestDomain(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  const labels = host.split(".").filter(Boolean);
  return labels.length <= 2 ? host : labels.slice(-2).join(".");
}

export function cookieInDomain(cookieDomain: string, domain: string): boolean {
  const bare = cookieDomain.replace(/^\./, "").toLowerCase();
  return bare === domain || bare.endsWith(`.${domain}`);
}

/** Shape `Storage.getCookies` returns; extra fields are ignored. */
interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size?: number;
  httpOnly: boolean;
  secure: boolean;
  session?: boolean;
  sameSite?: string;
}

/** Keep the sign-in site's cookies and normalize them to the store's shape. */
export function cookiesForDomain(cdpCookies: CdpCookie[], domain: string): Cookie[] {
  return cdpCookies
    .filter((cookie) => cookieInDomain(cookie.domain, domain))
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || "/",
      expires: typeof cookie.expires === "number" ? cookie.expires : -1,
      ...(cookie.size === undefined ? {} : { size: cookie.size }),
      httpOnly: Boolean(cookie.httpOnly),
      secure: Boolean(cookie.secure),
      ...(cookie.session === undefined ? {} : { session: cookie.session }),
      ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    }));
}

/**
 * Regular expression, valid in both JavaScript and .NET, that matches a Chrome
 * command line running on `profileWindows`. It matches the `--user-data-dir`
 * argument exactly, with or without quotes around the path, so `...\profile`
 * never matches `...\profile-2`. Quotes are written as `\x22` so the pattern
 * survives being passed to PowerShell as an argument. Case-insensitive use is
 * intended, as Windows paths are.
 */
export function profileCommandLinePattern(profileWindows: string): string {
  const path = profileWindows.replace(/\\+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `--user-data-dir=\\x22?${path}\\\\?(\\x22|\\s|$)`;
}

/** PowerShell function listing the Chrome processes whose command line matches `$Pattern`. */
const PROFILE_PROCESS_FUNCTION =
  "function Get-ProfileChrome { @(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -match $Pattern }) }";

/**
 * PowerShell that throws while any Chrome is still running on the profile: a
 * second Chrome on the same profile hands its work to the first and exits.
 */
const REFUSE_OPEN_PROFILE_LINES = [
  PROFILE_PROCESS_FUNCTION,
  "$alive = Get-ProfileChrome",
  "if ($alive.Count -gt 0) { throw \"Chrome is still running on the sign-in profile (process $(($alive | ForEach-Object { $_.ProcessId }) -join ', ')). Close that window and try again.\" }",
];

/**
 * PowerShell that starts Chrome headless on `$Profile` with `extraArgs`, waits
 * for the DevToolsActivePort file it writes, and connects to the browser
 * endpoint, defining `Send`, `Recv`, and `Wait-Reply` for the conversation.
 * It refuses to start while any Chrome is still running on the profile,
 * which would otherwise surface as a confusing startup failure.
 */
function headlessSessionLines(extraArgs: string[]): string[] {
  const quoted = extraArgs.map((arg) => `'${arg}'`).join(", ");
  return [
    ...REFUSE_OPEN_PROFILE_LINES,
    "$portFile = Join-Path $Profile 'DevToolsActivePort'",
    "if (Test-Path $portFile) { Remove-Item $portFile -Force }",
    `$chromeArgs = @('--headless=new', '--no-first-run', '--no-default-browser-check', ${quoted ? `${quoted}, ` : ""}'--remote-debugging-port=0', "--user-data-dir=\`"$Profile\`"", 'about:blank')`,
    "$proc = Start-Process -FilePath $Chrome -ArgumentList $chromeArgs -PassThru -WindowStyle Hidden",
    "$deadline = (Get-Date).AddSeconds($StartupSeconds)",
    "while (-not (Test-Path $portFile)) { if ((Get-Date) -gt $deadline) { throw 'Windows Chrome did not open its DevTools port in time.' }; if ($proc.HasExited) { throw 'Windows Chrome exited before opening its DevTools port; another Chrome may have opened on the sign-in profile.' }; Start-Sleep -Milliseconds 250 }",
    "Start-Sleep -Milliseconds 200",
    "$lines = Get-Content $portFile",
    "$port = [int]$lines[0]; $path = $lines[1]",
    "$ws = New-Object System.Net.WebSockets.ClientWebSocket",
    "$cts = New-Object System.Threading.CancellationTokenSource 30000",
    '$ws.ConnectAsync([Uri]("ws://127.0.0.1:$port$path"), $cts.Token).Wait()',
    "function Send($obj) { $b = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 6)); $ws.SendAsync([ArraySegment[byte]]$b, 'Text', $true, $cts.Token).Wait() }",
    "function Recv() { $buf = New-Object byte[] 65536; $ms = New-Object IO.MemoryStream; do { $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $cts.Token).Result; $ms.Write($buf, 0, $r.Count) } while (-not $r.EndOfMessage); [Text.Encoding]::UTF8.GetString($ms.ToArray()) }",
    "function Wait-Reply([int]$n) { while ($true) { $m = Recv; if ($m -match ('\"id\":' + $n + '[,}]')) { return $m } } }",
  ];
}

/** PowerShell that closes the headless browser started by `headlessSessionLines`. */
const CLOSE_HEADLESS_LINES = [
  "try { Send @{ id = 0; method = 'Browser.close' } } catch {}",
  "if (-not $proc.WaitForExit(10000)) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }",
];

/**
 * PowerShell that sets the profile's startup preference to "continue where
 * you left off". Chrome deletes browser-session cookies (cookies with no
 * expiry) when it exits normally unless that preference is set, and many
 * sign-ins keep the signed-in state only in such cookies. With it set, the
 * person can simply close the window and the sign-in survives for the
 * harvest, and the next sign-in window reopens where they left off.
 *
 * The preference is protected against edits to the profile's files, so the
 * script sets it the way the settings page does: it opens the profile
 * headless, loads the settings page, and calls the settings API there. When
 * the profile's preference files already show the value, Chrome is not
 * started. The script prints `{"changed":bool,"value":n}`.
 */
export function keepSessionScript(): string {
  return [
    "param([string]$Chrome, [string]$Profile, [string]$Pattern, [int]$StartupSeconds = 30)",
    "$ErrorActionPreference = 'Stop'",
    ...REFUSE_OPEN_PROFILE_LINES,
    "foreach ($name in @('Secure Preferences', 'Preferences')) { $prefsFile = Join-Path (Join-Path $Profile 'Default') $name; if (Test-Path $prefsFile) { try { $prefs = Get-Content -Raw $prefsFile | ConvertFrom-Json; if ($prefs.session.restore_on_startup -eq 1) { [Console]::Out.Write('{\"changed\":false,\"value\":1}'); exit 0 } } catch {} } }",
    ...headlessSessionLines([]),
    "Send @{ id = 1; method = 'Target.createTarget'; params = @{ url = 'chrome://settings/onStartup' } }",
    "$targetId = (ConvertFrom-Json (Wait-Reply 1)).result.targetId",
    "Send @{ id = 2; method = 'Target.attachToTarget'; params = @{ targetId = $targetId; flatten = $true } }",
    "$sessionId = (ConvertFrom-Json (Wait-Reply 2)).result.sessionId",
    "$expr = \"new Promise((resolve) => { const started = Date.now(); const attempt = () => { const api = globalThis.chrome && chrome.settingsPrivate; if (api) { api.setPref('session.restore_on_startup', 1, '', () => api.getPref('session.restore_on_startup', (pref) => resolve(JSON.stringify({ changed: true, value: pref ? pref.value : null })))); } else if (Date.now() - started > 10000) { resolve(JSON.stringify({ changed: false, value: null })); } else { setTimeout(attempt, 100); } }; attempt(); })\"",
    "Send @{ id = 3; sessionId = $sessionId; method = 'Runtime.evaluate'; params = @{ expression = $expr; awaitPromise = $true; returnByValue = $true } }",
    "$value = (ConvertFrom-Json (Wait-Reply 3)).result.result.value",
    "Start-Sleep -Milliseconds 300",
    ...CLOSE_HEADLESS_LINES,
    "[Console]::Out.Write($value)",
  ].join("\r\n");
}

/**
 * PowerShell that does the whole read on the Windows side: start Chrome
 * headless on the profile with its last session restored, read every cookie
 * with `Storage.getCookies`, list the open pages with `Target.getTargets`,
 * write both raw responses to stdout as one JSON object, and close the
 * browser. WSL never touches the profile folder, which it may not be able to
 * list. Every wait carries a deadline.
 *
 * Restoring the session keeps browser-session cookies that a forced stop left
 * on disk, and it reopens the tabs the person had open, so the harvest can
 * report the last page they reached on the sign-in site. That page's URL may
 * carry a per-session token that cookies alone do not replace. The page list
 * is polled for up to `$PageSeconds` until a page on `$Domain` appears.
 */
export function harvestScript(): string {
  return [
    "param([string]$Chrome, [string]$Profile, [string]$Pattern, [string]$Domain = '', [int]$StartupSeconds = 30, [int]$PageSeconds = 5)",
    "$ErrorActionPreference = 'Stop'",
    ...headlessSessionLines(["--restore-last-session"]),
    "function Test-SiteUrl([string]$u) { if (-not $Domain) { return $false }; try { $h = ([Uri]$u).Host.ToLowerInvariant() } catch { return $false }; return ($h -eq $Domain -or $h.EndsWith('.' + $Domain)) }",
    "Send @{ id = 1; method = 'Storage.getCookies' }",
    "$cookiesReply = Wait-Reply 1",
    "$pageDeadline = (Get-Date).AddSeconds($PageSeconds)",
    "$n = 1",
    "while ($true) { $n++; Send @{ id = $n; method = 'Target.getTargets' }; $targetsReply = Wait-Reply $n; $sitePages = @((ConvertFrom-Json $targetsReply).result.targetInfos | Where-Object { $_.type -eq 'page' -and (Test-SiteUrl $_.url) }); if ($sitePages.Count -gt 0 -or (Get-Date) -gt $pageDeadline) { break }; Start-Sleep -Milliseconds 250 }",
    "[Console]::Out.Write('{\"cookies\":' + $cookiesReply + ',\"targets\":' + $targetsReply + '}')",
    ...CLOSE_HEADLESS_LINES,
  ].join("\r\n");
}

/** Shape `Target.getTargets` returns; extra fields are ignored. */
interface CdpTargetInfo {
  type: string;
  url: string;
}

/**
 * URLs of the open pages on the sign-in site, in the order Chrome lists them,
 * without duplicates.
 */
export function sitePages(targets: CdpTargetInfo[], domain: string): string[] {
  const pages: string[] = [];
  for (const target of targets) {
    if (target.type !== "page") continue;
    let host: string;
    try {
      host = new URL(target.url).hostname;
    } catch {
      continue;
    }
    if (host && cookieInDomain(host, domain) && !pages.includes(target.url)) pages.push(target.url);
  }
  return pages;
}

export interface WindowsChromeHarvest {
  /** The sign-in site's cookies, browser-session cookies included. */
  cookies: Cookie[];
  /** Open pages on the sign-in site; the first is the one to resume from. */
  pages: string[];
}

/** Parse the harvest script's stdout. */
export function parseHarvestOutput(stdout: string, domain: string): WindowsChromeHarvest {
  const parsed = JSON.parse(stdout) as {
    cookies?: { result?: { cookies?: CdpCookie[] }; error?: { message?: string } };
    targets?: { result?: { targetInfos?: CdpTargetInfo[] } };
  };
  const cookieList = parsed.cookies?.result?.cookies;
  if (!cookieList)
    throw new Error(
      `Windows Chrome returned no cookie list: ${parsed.cookies?.error?.message ?? "unknown response"}`,
    );
  return {
    cookies: cookiesForDomain(cookieList, domain),
    pages: sitePages(parsed.targets?.result?.targetInfos ?? [], domain),
  };
}

/** Write a PowerShell script to a temp file and run it with `-File`. */
function runPowerShellScript(
  name: string,
  script: string,
  args: string[],
  timeoutMs: number,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const scriptDir = join(tmpdir(), "harnery-windows-chrome");
  mkdirSync(scriptDir, { recursive: true });
  const scriptLinux = join(scriptDir, `${name}-${process.pid}.ps1`);
  writeFileSync(scriptLinux, script, { mode: 0o600 });
  try {
    const scriptWindows = spawnSync("wslpath", ["-w", scriptLinux], {
      encoding: "utf8",
    }).stdout.trim();
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptWindows, ...args],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    };
  } finally {
    rmSync(scriptLinux, { force: true });
  }
}

/**
 * Reopen the Windows profile headless with its last session restored, read
 * its cookies for `domain` and its open pages on that site, and close it.
 * The profile must already be closed; see `stopWindowsChromeProfile`.
 */
export function harvestWindowsChromeCookies(input: {
  chromeWindows: string;
  profileWindows: string;
  domain: string;
  startupTimeoutSeconds?: number;
  pageTimeoutSeconds?: number;
}): WindowsChromeHarvest {
  const result = runPowerShellScript(
    "harvest-cookies",
    harvestScript(),
    [
      "-Chrome",
      input.chromeWindows,
      "-Profile",
      input.profileWindows,
      "-Pattern",
      profileCommandLinePattern(input.profileWindows),
      "-Domain",
      input.domain,
      "-StartupSeconds",
      String(input.startupTimeoutSeconds ?? 30),
      "-PageSeconds",
      String(input.pageTimeoutSeconds ?? 5),
    ],
    90_000,
  );
  if (result.status !== 0) {
    throw new Error(
      `Reading cookies from Windows Chrome failed: ${(result.stderr || result.stdout || result.error?.message || "no output").trim().slice(0, 400)}`,
    );
  }
  return parseHarvestOutput(result.stdout, input.domain);
}

export interface WindowsChromeKeepSession {
  /** True when the preference was already set or is now set. */
  kept: boolean;
  /** True when this call changed the preference. */
  changed: boolean;
}

/**
 * Set the profile to keep browser-session cookies across a normal exit; see
 * `keepSessionScript`. Throws when Chrome is already open on the profile,
 * since a second sign-in window would hand off to it. Any other failure
 * returns `kept: false` so the caller can warn and continue.
 */
export function keepWindowsChromeSession(input: {
  chromeWindows: string;
  profileWindows: string;
  startupTimeoutSeconds?: number;
}): WindowsChromeKeepSession {
  const result = runPowerShellScript(
    "keep-session",
    keepSessionScript(),
    [
      "-Chrome",
      input.chromeWindows,
      "-Profile",
      input.profileWindows,
      "-Pattern",
      profileCommandLinePattern(input.profileWindows),
      "-StartupSeconds",
      String(input.startupTimeoutSeconds ?? 30),
    ],
    90_000,
  );
  const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
  if (result.status !== 0) {
    if (detail.includes("Chrome is still running on the sign-in profile"))
      throw new Error(
        `Chrome is already open on the sign-in profile ${input.profileWindows}. Close that window and run the sign-in again.`,
      );
    return { kept: false, changed: false };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { changed?: boolean; value?: unknown };
    return { kept: parsed.value === 1, changed: parsed.changed === true };
  } catch {
    return { kept: false, changed: false };
  }
}

/**
 * PowerShell that closes every Chrome whose command line matches `$Pattern`. It asks each window to
 * close, repeating so a profile with several windows closes them all, which
 * lets Chrome write its cookies and session to disk. Whatever is still
 * running after `$CloseSeconds` is stopped by force. The script prints
 * `{found, forced, remaining}` as JSON; `remaining` lists process ids that
 * survived even the forced stop.
 */
export function stopScript(): string {
  return [
    "param([string]$Pattern, [int]$CloseSeconds = 15)",
    "$ErrorActionPreference = 'Stop'",
    PROFILE_PROCESS_FUNCTION,
    "$found = (Get-ProfileChrome).Count",
    "$deadline = (Get-Date).AddSeconds($CloseSeconds)",
    "while ($true) { $procs = Get-ProfileChrome; if ($procs.Count -eq 0 -or (Get-Date) -gt $deadline) { break }; foreach ($c in $procs) { try { $p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } } catch {} }; Start-Sleep -Milliseconds 500 }",
    "$forced = 0",
    "foreach ($c in $(Get-ProfileChrome)) { Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue; $forced++ }",
    "if ($forced -gt 0) { $killDeadline = (Get-Date).AddSeconds(10); while ((Get-ProfileChrome).Count -gt 0 -and (Get-Date) -lt $killDeadline) { Start-Sleep -Milliseconds 250 } }",
    "$remaining = @(Get-ProfileChrome | ForEach-Object { [int]$_.ProcessId })",
    "[Console]::Out.Write((@{ found = $found; forced = $forced; remaining = $remaining } | ConvertTo-Json -Compress))",
  ].join("\r\n");
}

export interface WindowsChromeStop {
  /** Chrome processes running on the profile when the stop began. */
  found: number;
  /** Processes that ignored the close request and were stopped by force. */
  forced: number;
}

/** Parse the stop script's stdout; throws when a process survived. */
export function parseStopOutput(stdout: string, profileWindows: string): WindowsChromeStop {
  const parsed = JSON.parse(stdout) as {
    found?: number;
    forced?: number;
    remaining?: number | number[] | null;
  };
  const remaining =
    parsed.remaining === undefined || parsed.remaining === null
      ? []
      : Array.isArray(parsed.remaining)
        ? parsed.remaining
        : [parsed.remaining];
  if (remaining.length > 0) {
    throw new Error(
      `Chrome is still running on ${profileWindows} (process ${remaining.join(", ")}) after a forced stop; its cookies cannot be read until it exits.`,
    );
  }
  return { found: Number(parsed.found ?? 0), forced: Number(parsed.forced ?? 0) };
}

/**
 * Close every Chrome still running on `profileWindows`, for when the person
 * ends the sign-in from the terminal while the window is open. The profile
 * must be closed before its cookies can be read. Closing the windows lets
 * Chrome write recent cookies to disk; a forced stop is the fallback after
 * `closeSeconds`, and it can lose cookies Chrome had not yet written. Throws
 * when the stop cannot be confirmed, so the harvest never runs against a
 * profile that is still open.
 */
export function stopWindowsChromeProfile(
  profileWindows: string,
  closeSeconds = 15,
): WindowsChromeStop {
  const result = runPowerShellScript(
    "stop-profile",
    stopScript(),
    ["-Pattern", profileCommandLinePattern(profileWindows), "-CloseSeconds", String(closeSeconds)],
    (closeSeconds + 60) * 1000,
  );
  if (result.status !== 0) {
    throw new Error(
      `Closing Chrome on ${profileWindows} failed: ${(result.stderr || result.stdout || result.error?.message || "no output").trim().slice(0, 400)}`,
    );
  }
  return parseStopOutput(result.stdout, profileWindows);
}

/**
 * PowerShell that lists the Chrome processes running on the profile matched
 * by `$Pattern` and prints their ids as a JSON array. It never closes them.
 */
export function runningScript(): string {
  return [
    "param([string]$Pattern)",
    "$ErrorActionPreference = 'Stop'",
    PROFILE_PROCESS_FUNCTION,
    "$ids = @(Get-ProfileChrome | ForEach-Object { [int]$_.ProcessId })",
    "[Console]::Out.Write((ConvertTo-Json -Compress -InputObject $ids))",
  ].join("\r\n");
}

/** Parse the running script's stdout into process ids. */
export function parseRunningOutput(stdout: string): number[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as number | number[] | null;
  if (parsed === null) return [];
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number);
}

/**
 * Ids of the Chrome processes running on `profileWindows`, for callers that
 * must leave an open profile alone. Throws when the check cannot run.
 */
export function windowsChromeProfileProcesses(profileWindows: string): number[] {
  const result = runPowerShellScript(
    "profile-running",
    runningScript(),
    ["-Pattern", profileCommandLinePattern(profileWindows)],
    30_000,
  );
  if (result.status !== 0) {
    throw new Error(
      `Checking for Chrome on ${profileWindows} failed: ${(result.stderr || result.stdout || result.error?.message || "no output").trim().slice(0, 400)}`,
    );
  }
  return parseRunningOutput(result.stdout);
}

/** Linux form of a drive-letter Windows path (`C:\x` becomes `/mnt/c/x`). */
export function windowsPathToWsl(windowsPath: string): string {
  const match = /^([A-Za-z]):\\(.*)$/.exec(windowsPath);
  if (!match) throw new Error(`Not a drive-letter path: ${windowsPath}`);
  const rest = (match[2] ?? "").replace(/\\+/g, "/").replace(/\/+$/, "");
  return `/mnt/${(match[1] as string).toLowerCase()}${rest ? `/${rest}` : ""}`;
}

/** Windows form of a `/mnt/<drive>/...` path. */
export function wslPathToWindows(linuxPath: string): string {
  const match = /^\/mnt\/([a-z])\/(.*)$/.exec(linuxPath);
  if (!match) throw new Error(`Not a /mnt/<drive> path: ${linuxPath}`);
  return `${(match[1] as string).toUpperCase()}:\\${(match[2] ?? "").replace(/\//g, "\\")}`;
}
