---
"harnery": patch
---

The presence relay daemon and the governor background service now start on Windows. Both spawned `bin/harn` from a `new URL(...).pathname`, which on Windows is `/C:/...` (so the existence check failed and the relay silently fell back to git refs) and names a POSIX shell script Windows cannot execute. They now run the CLI entry with the current runtime (`process.execPath`), like the self-update runner, through a shared `harnCliEntry()`. The relay daemon is also pinned to the project that started it (`HARNERY_COORD_ROOT_OVERRIDE`), so an inherited project directory naming another checkout no longer makes it exit with "no relay configured".
