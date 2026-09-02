---
"harnery": patch
---

Ignore canceled Next.js React Server Component prefetches in browser diagnostics
so Chromium's `net::ERR_ABORTED` event does not fail a healthy page. Other
aborted requests still count as failures.
