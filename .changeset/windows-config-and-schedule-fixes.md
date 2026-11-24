---
"harnery": patch
---

Read a config file again when it changed within the last two seconds, so two quick writes of the same size are never served from the cache. Close the schedule store copy before deleting it when the file is not a database, so Windows can remove it. Keep the systemd timer's unit folder and PATH list in POSIX form on every host.
