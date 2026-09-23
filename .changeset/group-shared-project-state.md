---
"harnery": minor
---

Add `storage.sharing` to `.harnery/config.jsonc`. The default, `private`, keeps
project state owner-only as before. `group` writes state directories `0770` and
files `0660`, so several Unix users who share the project directory's group can
coordinate in one project, and integrity checks accept group access while still
rejecting any access by other users. The setting is read from the project file
only; `HARNERY_STORAGE_SHARING` overrides it per process.
