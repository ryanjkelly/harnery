import { readFileSync } from "node:fs";

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
