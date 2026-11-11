---
"harnery": minor
---

**Breaking:** removed the `inbox`, `messages`, `conversations` and `sync` top-level commands (ADR 0243). The first three needed a service the host had to supply, and no host did, so they could not run. `sync` had no users.

- `harn inbox` (including `inbox watch`): use `harn agents inbox`, which keeps `list`, `status` and `watch`.
- `harn messages`: use `harn agents ping`.
- `harn conversations`: no replacement. The `./core/conversations` export stays.
- `harn sync`: no replacement. The `sync` config section, its schema entry, the `HARNERY_SYNC_REMOTE` and `HARNERY_SYNC_PREFIX` variables and the `~/.config/harnery/sync.json` fallback are gone, and `harn doctor` no longer checks for `rclone`.

The `coordinationInbox` and `conversations` fields of the program context are removed. No package export is removed.
