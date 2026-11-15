---
"harnery": patch
---

Tighten the Stop hook's self-repair. A hook-side status check that fails or times out no longer lets a turn end when the hook's own check of owned work was also unavailable. A status followed by another tool call is rerun even when the paste or the task is also missing. A project that does not require Git finalization gets the ordinary status from the repair, never the commit-and-push check.
