---
"harnery": patch
---

Gate the registered-screenshot thumbnail test on an installed browser, matching
the renderer suite. The dashboard workflow installs no Chromium, so the test's
post-edit re-render assertion failed there instead of skipping.
