---
"harnery": minor
---

feat(web): lazy-fetch the dashboard for npm consumers

`harn web up` / `build` / `start` now auto-fetch the dashboard the first time they run from an npm install that has no bundled `web/`. They clone the harnery repo at the matching version tag into `~/.cache/harnery/web/<ref>` and install the web app's deps (web/ only, no root install, no browser download), then run it; later runs reuse the cache.

- `--no-fetch` skips the fetch and prints manual steps instead.
- `HARNERY_WEB_REF` overrides the git ref (default: the installed version's `v<version>` tag).

Resolves ADR 0003. Previously `harn web up` could only tell npm consumers to clone the repo themselves.
