---
"harnery": minor
---

The shared PreToolUse hook now denies shell `rm` (including `xargs rm`, `find -exec rm`, and `bash -c` forms) and points agents to `<bin> rm`, `git rm`, or `artifacts discard`. `HARNERY_ALLOW_RM=1` on the command overrides.
