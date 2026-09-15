import { existsSync, readFileSync } from "node:fs";

/**
 * Chromium launch-arg helpers for environment-specific workarounds.
 *
 * The one that matters today is WSLg: a headed Chromium window renders its
 * page to a GPU-backed surface that WSLg composites over an RDP stream to the
 * Windows host. On a range of Windows / GPU-driver / WSLg combinations that
 * GPU-composited surface never presents, so the window shows in the taskbar
 * but paints blank — even though the page itself runs fine (JS, navigation,
 * and DOM all work). Forcing Chromium onto its software compositor with
 * `--disable-gpu` restores on-screen paint. It only matters for headed mode
 * (headless never composites to a display) and only under WSL.
 */

/** True when running under WSL (WSL1 or WSL2). */
export function isWSL(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * Chromium launch flags to make a headed window paint under WSLg. Returns
 * `["--disable-gpu"]` on WSL, `[]` elsewhere. Callers apply these only for
 * headed launches. See the module doc for the failure mode.
 */
export function wslHeadedLaunchArgs(): string[] {
  return isWSL() ? ["--disable-gpu"] : [];
}

/**
 * Playwright's bundled browser is "Chrome for Testing", launched with
 * `--enable-automation`. Both are visible to the page: the User-Agent brand
 * list carries "Chrome for Testing" and `navigator.webdriver` reads true, so
 * sign-in flows on sites that screen for automation (X, some banks, some
 * Cloudflare-fronted apps) silently refuse clicks in a headed window that a
 * person is driving. Headed sessions therefore launch the operator's real
 * Google Chrome when one is installed and drop the automation signals.
 */

/** Default Chromium args Playwright adds that a headed session must not carry. */
export const AUTOMATION_DEFAULT_ARGS_TO_DROP: readonly string[] = ["--enable-automation"];

/** Launch flags that stop Blink from reporting the automation state to pages. */
export function automationDisguiseArgs(): string[] {
  return ["--disable-blink-features=AutomationControlled"];
}

const CHROME_PATHS: Record<string, string[]> = {
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ],
};

/**
 * `"chrome"` when a stable Google Chrome install is present at a well-known
 * path for this platform, else `undefined` (use Playwright's bundled
 * Chromium). Playwright resolves the `chrome` channel to the same install, so
 * the check only has to answer whether asking for it can succeed.
 */
export function installedChromeChannel(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): "chrome" | undefined {
  return installedChromePath(platform, exists) ? "chrome" : undefined;
}

/**
 * Filesystem path of the installed stable Google Chrome for this platform, or
 * `undefined`. Used to spawn Chrome with nothing attached for sign-in flows
 * whose verification vendors detect the DevTools protocol itself.
 */
export function installedChromePath(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return (CHROME_PATHS[platform] ?? []).find((candidate) => exists(candidate));
}
