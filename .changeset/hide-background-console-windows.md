---
"harnery": patch
---

Background work no longer opens terminal windows on Windows. The session-maintenance worker starts detached with no console, so every console program it ran (the artifact sweep calls `git ls-files` once per candidate) got a new console of its own, and Windows Terminal showed each one as a window: one about every three seconds for the length of the sweep. The artifact sweep's `git` call, presence `git`, the process-log wrapper, the backup scheduler, the session-sync script, and the session-maintenance and runtime-context-retry workers now all spawn with `windowsHide`.
