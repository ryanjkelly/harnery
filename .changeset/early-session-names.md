---
"harnery": patch
---

Require a newly suggested session name to appear as the next copyable assistant block before later tools can run. PostToolUse now injects the exact block, PreToolUse verifies it across Claude Code, Codex, and Cursor, and prompt reminders continue until the current name is actually observed. The gate always permits single `agents set-task` and `agents status` remediation commands, so it cannot deadlock its own turn-closing workflow.
