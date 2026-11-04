---
"harnery": minor
---

Browser launches keep the Chromium sandbox on by default, headed and headless. `HARNERY_BROWSER_SANDBOX=0` is the explicit opt-out for containers without user namespaces; a `--no-sandbox` launch argument is refused while the sandbox is on, and a sandbox start failure names the remedy. Headless `harn browse` now uses the installed Google Chrome when its version is at least the bundled Chromium's, because the bundled build is pinned at the Playwright release and can miss later Chrome security fixes. New toolkit helpers: `browserSandboxEnabled`, `assertSandboxArgs`, `explainSandboxLaunchError`, `chromeVersionFromExecutable`, `compareChromeVersions`, `preferredChromeChannel`.
