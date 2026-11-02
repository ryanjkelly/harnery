---
"harnery": patch
---

Scheduled backups now run on Windows. The SessionStart snapshot used to start through `bash`, which a Windows machine often lacks or resolves to the WSL launcher, and that launcher cannot run the Windows CLI path, so the snapshot never ran. Session start now launches a small background worker on the same Node or Bun runtime that runs the hook, and that worker runs the CLI with the same runtime. The log, its rotation past 256 KiB, the start and exit lines, and the status file keep their current format. A CLI that cannot start is still recorded as exit 127.
