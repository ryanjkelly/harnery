---
"harnery": minor
---

Session-name suggestion for the operator's harness tab title, folded into the focus declaration.

`harn agents set-task`, on the **first** focus declaration of a session (detected by the absence of a prior `task_updated_at` stamp), now returns `first_of_session: true` and a `suggested_session_name` (`Agent <you> - <task>`) alongside its usual payload — one declaration feeds both the peer-visible task and the tab name. The agent reproduces the name in a fenced code block so the chat UI's Copy button hands the operator the exact string. Every later `set-task` returns `first_of_session: false` and a null name.

`harn agents suggest-name` becomes the read-only secondary path: reprint the current session's name or re-suggest after a topic pivot. Its description arg is now optional — with no arg it derives the name from the current task. Prints the bare name (no box); `--json` for the structured form; `--session-id <id>` bypasses the ppid walk like `status`/`set-task`.
