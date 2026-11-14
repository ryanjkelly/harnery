---
"harnery": minor
---

Harnery now delivers a session's title through a title surface. In Claude Code and Codex sessions hosted as T3 Code threads, the agent renames its own thread to the session name instead of printing the copyable name block, and Harnery confirms the rename from the tool call. When the session is marked done, the thread keeps its current title with `[DONE] ` added, so a title the person edited by hand keeps its wording. Every other client keeps the name block, and `agents set-task`, `agents lifecycle` and `agents suggest-name` JSON now reports the surface in `title_surface`.
