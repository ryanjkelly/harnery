---
"harnery": patch
---

Fix: `browse --headed` / `--login` windows paint blank under WSLg. WSLg composites Chromium's GPU-backed surface over an RDP stream, and on many Windows/GPU/WSLg combinations that surface never presents — the window shows in the taskbar but never paints, even though the page runs fine (JS, navigation, DOM all work). `browse` now auto-adds `--disable-gpu` to headed launches under WSL (forcing the software compositor), opt-out via `HARNERY_BROWSER_NO_WSL_DEFAULTS=1`. New `--browser-arg <flag>` (repeatable) and `HARNERY_BROWSER_ARGS` (whitespace-separated) pass arbitrary Chromium launch flags for other environment-specific workarounds. `BrowserOptions` gains a `launchArgs?: string[]` passthrough, and `harnery/lib/browser` now exports `isWSL()` + `wslHeadedLaunchArgs()` for embedding hosts that launch their own headed browsers.
