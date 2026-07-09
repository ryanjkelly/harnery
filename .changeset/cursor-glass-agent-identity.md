---
"harnery": patch
---

Fix Cursor Glass agent identity resolution. `harn agents whoami/status/set-task` now recognizes `CURSOR_CONVERSATION_ID`, prefers per-chat session-env identity over Cursor's shared node pid-map row, and lazily bootstraps a missing Cursor heartbeat from the first agents CLI call.
