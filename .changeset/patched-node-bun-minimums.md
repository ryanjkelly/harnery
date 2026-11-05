---
"harnery": minor
---

Require Node 22.23.4, 24.22.1, or 26.12.1 and later releases on supported lines. These releases fix the Brotli decoder vulnerability. Doctor now rejects older Node versions and installed Bun versions below 1.4.4. CI and release jobs also use patched runtimes.
