---
"harnery": patch
---

`harn doctor` now reports the `node` executable on PATH. Under Bun it previously showed the Node version Bun emulates, which could hide an old or missing Node install. A missing Node under Bun is a warning, and Node older than 20 still fails.
