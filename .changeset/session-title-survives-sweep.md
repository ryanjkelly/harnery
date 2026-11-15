---
"harnery": patch
---

Keep a session's title when the stale sweep deletes its idle cache. The title state now also lives in `.harnery/session-titles/<instance>.json`, which the sweep keeps for 30 days, so a session that sits idle past the freshness window no longer mints a new title on its next `set-task` and no longer asks a writing surface such as T3 Code to rename the thread mid-session.
