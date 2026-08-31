---
"harnery": patch
---

Rename the `agents health` JSON field `zombies` to `heartbeat_cache_issues` so it matches the rendered `cache issues` row and the condition it actually measures. Stale or malformed heartbeat cache files are not zombie processes.
