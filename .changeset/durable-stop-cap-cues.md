---
"harnery": patch
---

Keep unmet Stop-check cues in the project's coordination state so the next prompt
can deliver them after a restart or temporary-directory cleanup. Consume each cue
once, discard it after three days or on session end, and ignore storage failures.
