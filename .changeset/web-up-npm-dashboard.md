---
"harnery": patch
---

`harn web up` works again from an npm install. The first-run dashboard fetch now installs the repository root's dependencies as well as `web/`'s, so `next.config.ts` can resolve `playwright`; it previously stopped with `Cannot find module 'playwright/package.json'`. `next dev` now receives one combined preload, `web/server-preload.mjs`, which loads the keep-alive and request-diagnostics hooks. Next merges every `--import` it forwards to its dev server into a single space-joined path, so the two separate preloads made the dashboard exit with `ERR_MODULE_NOT_FOUND` before it started. A cached dashboard with only `web/` installed is fetched again.
