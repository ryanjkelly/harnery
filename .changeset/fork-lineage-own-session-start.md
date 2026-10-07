---
"harnery": minor
---

Claude Code forks record their lineage again. Both fork flows now start under the fork's own id, so Harnery detects the parent at session start (from copied rows that keep the parent's session id) or at the fork's first tool call (from preserved message uuids), and treats inherited history from a finished session as a continuation. A fork of a live session is told the parent's name, task, and files and not to end it; peer tables and `agents status` label the parent and the fork; and `agents end` and `agents lifecycle --session-id` refuse a fork ancestor without `--force-ancestor`.
