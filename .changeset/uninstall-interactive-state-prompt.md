---
"harnery": minor
---

feat(uninstall): ask before deleting .harnery/ and point at engine removal

Standalone `harn uninstall`, run on a terminal, now asks before deleting the
.harnery/ coord root when --purge-state wasn't passed and a coord root exists
(defaulting to no). After a real uninstall it also prints how to remove the
harnery CLI itself (`npm rm -g harnery`, or the clone), which a running command
can't do to its own package. This mirrors the shell `uninstall.sh` prompts so
the npm and git-clone paths feel the same.

Both are gated to standalone harn: an embedding host routes output through its
own emit and owns its install lifecycle, so `<host> uninstall` stays strictly
flag-driven and silent about removing the package. The prompt also never fires
off a TTY, so scripted / CI runs are unchanged. The gating
(shouldPromptForState) and the hint text (engineRemovalHint) are pure and
unit-tested.
