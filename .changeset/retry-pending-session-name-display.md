---
"harnery": patch
---

Let a latched session recover by repeating `agents set-task`. While the current session name is still pending, the command now returns the unchanged name with `session_name_retry: true`, and PostToolUse creates a fresh ordered display boundary for the next exact block.
