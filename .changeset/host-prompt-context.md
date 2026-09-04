---
"harnery": minor
---

Add a project-owned prompt-context extension to the normalized hook path.

Embedding hosts can opt into one versioned provider contract while Harnery
keeps adapter routing, bounded execution, sensitive-state handling, and
redacted audit behavior in one place. Claude Code and Codex receive context
directly. Cursor receives a session-bound consume command until its prompt hook
supports direct context injection.
