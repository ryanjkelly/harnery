---
"harnery": minor
---

Headed `browse` sessions (`--login`, `--headed`) now launch the operator's installed Google Chrome when one exists, drop Playwright's `--enable-automation` default, and disable Blink's AutomationControlled feature, so pages no longer see "Chrome for Testing" or `navigator.webdriver`. Sign-in flows that screened for automation and refused clicks in the headed window (X was the reported case) now behave as in a normal browser. New `--browser-channel <chrome|chrome-beta|msedge|chromium>` and `HARNERY_BROWSER_CHANNEL` choose the browser explicitly; headless runs keep the bundled Chromium. The `BrowserClient` gains `channel` and `hideAutomation` options.
