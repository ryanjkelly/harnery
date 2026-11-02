---
"harnery": patch
---

The commit guard groups a committer with its own subagents again. When the hook passes no session, the guard now uses the committer's own session id, the value its subagents carry, so a parent committing a subagent's work is no longer blocked by its own team.