---
"harnery": minor
---

The Stop hook now heals a tool turn instead of refusing it when the missing step is one it can do itself. A missing or outdated closing status makes the hook run `agents status --end-turn` itself under a 20-second deadline; a status that was not pasted is shown to the person through Claude Code's `systemMessage`; a turn without `set-task` in a session that already has a task records the same task again. Unfinished Git work still refuses, and a session that has never declared a task is refused in one stop cycle only. Healed stops record `stop-hook.healed_status_run`, `stop-hook.healed_status_display`, or `stop-hook.healed_task_carried`. `HARNERY_END_TURN_SYNC_TIMEOUT_MS` can lower the end-turn sync's two-minute bound. The injected turn-ritual guidance and the Cursor rule no longer say a missing status is refused.
