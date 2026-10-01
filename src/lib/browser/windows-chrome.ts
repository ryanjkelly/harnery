import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookie } from "../cookies/client.ts";

/**
 * Sign-in through the Windows host's Google Chrome when running under WSL.
 *
 * Some sign-in flows (X is the reported case) reject every browser running
 * inside WSL, including a plain Linux Google Chrome with nothing attached:
 * the sign-in request comes back "429 Too Many Requests" while the same
 * account signs in from the Windows desktop browser without trouble. The
 * Windows Chrome is the client those flows accept, so `browse --login
 * --plain` under WSL opens it on a dedicated Windows-side profile. The
 * person signs in there with nothing attached. Afterwards the profile is
 * reopened headless for a moment, its cookies for the sign-in site are read
 * through the DevTools protocol, and they are merged into the shared cookie
 * store that later `browse` runs attach. The Windows profile cannot be shared
 * with Linux Chromium directly because Windows encrypts its cookie database
 * with keys only Windows can read.
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
 * PowerShell that does the whole read on the Windows side: start Chrome
 * headless on the profile, wait for the DevToolsActivePort file it writes,
 * read every cookie with `Storage.getCookies`, write the raw response to
 * stdout, and close the browser. WSL never touches the profile folder, which
 * it may not be able to list. Every wait carries a deadline.
 */
export function harvestScript(): string {
  return [
    "param([string]$Chrome, [string]$Profile, [int]$StartupSeconds = 30)",
    "$ErrorActionPreference = 'Stop'",
    "$portFile = Join-Path $Profile 'DevToolsActivePort'",
    "if (Test-Path $portFile) { Remove-Item $portFile -Force }",
    "$args = @('--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', \"--user-data-dir=$Profile\", 'about:blank')",
    "$proc = Start-Process -FilePath $Chrome -ArgumentList $args -PassThru -WindowStyle Hidden",
    "$deadline = (Get-Date).AddSeconds($StartupSeconds)",
    "while (-not (Test-Path $portFile)) { if ((Get-Date) -gt $deadline) { throw 'Windows Chrome did not open its DevTools port in time.' }; if ($proc.HasExited) { throw 'Windows Chrome exited before opening its DevTools port.' }; Start-Sleep -Milliseconds 250 }",
    "Start-Sleep -Milliseconds 200",
    "$lines = Get-Content $portFile",
    "$port = [int]$lines[0]; $path = $lines[1]",
    "$ws = New-Object System.Net.WebSockets.ClientWebSocket",
    "$cts = New-Object System.Threading.CancellationTokenSource 20000",
    '$ws.ConnectAsync([Uri]("ws://127.0.0.1:$port$path"), $cts.Token).Wait()',
    "function Send($obj) { $b = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress)); $ws.SendAsync([ArraySegment[byte]]$b, 'Text', $true, $cts.Token).Wait() }",
    "function Recv() { $buf = New-Object byte[] 65536; $ms = New-Object IO.MemoryStream; do { $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $cts.Token).Result; $ms.Write($buf, 0, $r.Count) } while (-not $r.EndOfMessage); [Text.Encoding]::UTF8.GetString($ms.ToArray()) }",
    "Send @{ id = 1; method = 'Storage.getCookies' }",
    "$out = $null",
    "while ($null -eq $out) { $m = Recv; if ($m -match '\"id\":1[,}]') { $out = $m } }",
    "[Console]::Out.Write($out)",
    "try { Send @{ id = 2; method = 'Browser.close' } } catch {}",
    "if (-not $proc.WaitForExit(10000)) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }",
  ].join("\r\n");
}

/**
 * Reopen the Windows profile headless, read its cookies for `domain`, and
 * close it. Returns the cookies in the store's shape.
 */
export function harvestWindowsChromeCookies(input: {
  chromeWindows: string;
  profileWindows: string;
  domain: string;
  startupTimeoutSeconds?: number;
}): Cookie[] {
  const scriptDir = join(tmpdir(), "harnery-windows-chrome");
  mkdirSync(scriptDir, { recursive: true });
  const scriptLinux = join(scriptDir, `harvest-cookies-${process.pid}.ps1`);
  writeFileSync(scriptLinux, harvestScript(), { mode: 0o600 });
  try {
    const scriptWindows = spawnSync("wslpath", ["-w", scriptLinux], {
      encoding: "utf8",
    }).stdout.trim();
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptWindows,
        "-Chrome",
        input.chromeWindows,
        "-Profile",
        input.profileWindows,
        "-StartupSeconds",
        String(input.startupTimeoutSeconds ?? 30),
      ],
      { encoding: "utf8", timeout: 90_000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      throw new Error(
        `Reading cookies from Windows Chrome failed: ${(result.stderr || result.stdout || "no output").trim().slice(0, 400)}`,
      );
    }
    const parsed = JSON.parse(result.stdout) as {
      result?: { cookies?: CdpCookie[] };
      error?: { message?: string };
    };
    if (!parsed.result?.cookies)
      throw new Error(
        `Windows Chrome returned no cookie list: ${parsed.error?.message ?? "unknown response"}`,
      );
    return cookiesForDomain(parsed.result.cookies, input.domain);
  } finally {
    rmSync(scriptLinux, { force: true });
  }
}

/**
 * Close any Chrome still running on `profileWindows`, for when the person ends
 * the sign-in from the terminal while the window is open. The profile must be
 * closed before its cookies can be read. Closing the window first lets Chrome
 * write recent cookies to disk; a forced stop is the fallback after 15 s.
 */
export function stopWindowsChromeProfile(profileWindows: string): void {
  const escaped = profileWindows.replace(/'/g, "''");
  const select = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${escaped}*' }`;
  spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      [
        `$ids = @(${select} | ForEach-Object { $_.ProcessId })`,
        "foreach ($id in $ids) { $p = Get-Process -Id $id -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { [void]$p.CloseMainWindow() } }",
        "$deadline = (Get-Date).AddSeconds(15)",
        `while ((Get-Date) -lt $deadline -and @(${select}).Count -gt 0) { Start-Sleep -Milliseconds 250 }`,
        `${select} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ].join("; "),
    ],
    { encoding: "utf8", timeout: 45_000 },
  );
}

/** Windows form of a `/mnt/<drive>/...` path. */
export function wslPathToWindows(linuxPath: string): string {
  const match = /^\/mnt\/([a-z])\/(.*)$/.exec(linuxPath);
  if (!match) throw new Error(`Not a /mnt/<drive> path: ${linuxPath}`);
  return `${(match[1] as string).toUpperCase()}:\\${(match[2] ?? "").replace(/\//g, "\\")}`;
}
