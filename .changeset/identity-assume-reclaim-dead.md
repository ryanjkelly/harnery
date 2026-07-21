---
"harnery": patch
---

Make `agents identity assume` reclaim abandoned local namesakes whose harness process is dead (or missing from pid-map), instead of refusing for the full freshness window. Still refuses when another live process or cached remote presence holds the name.

Also skip Cursor sessionStart bootstrap in `ensureCursorSession` when `HARNERY_AGENT_COORD_OWNER` is already set, so whoami/assume fixtures under Cursor cannot wipe an assumed persona `agent_id`.
