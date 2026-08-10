---
"harnery": patch
---

Serialize Chromium process launches by default. Harnery still allows browsers
to run concurrently after startup, while avoiding transient Playwright
`connect ENOENT` failures when Bun's full test suite or a browse fan-out opens
several persistent contexts at once. Environments with extra process headroom
can raise `HARNERY_MAX_BROWSER_LAUNCHES` explicitly.
