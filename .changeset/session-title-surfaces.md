---
"harnery": minor
---

Harnery now delivers a session's title through a title surface. In Claude Code and Codex sessions hosted as T3 Code threads, the agent renames its own thread to the session name instead of printing the copyable name block, and Harnery confirms the rename from the tool call. Every other client keeps the name block, and `agents set-task`, `agents lifecycle` and `agents suggest-name` JSON now reports the surface in `title_surface`.
