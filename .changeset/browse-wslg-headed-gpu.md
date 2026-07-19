---
"harnery": patch
---

Configurable Chromium launch flags for `browse`, plus a WSLg headed default. New `--browser-arg <flag>` (repeatable) and `HARNERY_BROWSER_ARGS` (whitespace-separated) pass arbitrary Chromium launch flags for environment-specific workarounds; `BrowserOptions` gains a `launchArgs?: string[]` passthrough, and `harnery/lib/browser` exports `isWSL()` + `wslHeadedLaunchArgs()` for embedding hosts that launch their own headed browsers. Under WSL, headed launches auto-add `--disable-gpu` (opt out with `HARNERY_BROWSER_NO_WSL_DEFAULTS=1`) to mitigate the common WSLg GPU-compositing blank-window mode — note that a blank headed window can ALSO mean WSLg's shared-memory pixel channel is dead (`rdp_allocate_shared_memory … Input/output error` in `/mnt/wslg/weston.log`), which no flag fixes; that needs `wsl --shutdown`. The browse docs cover distinguishing the two.
