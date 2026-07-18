---
"harnery": minor
---

`harn agents suggest-name <description>`: renders a copy-pasteable session name (`Agent <you> - <description>`) for the operator to set as their harness session/tab title. Meant to run on an agent's first turn of a new session, so the operator can name the tab from a suggestion built off the coord identity + a short summary the agent supplies, instead of typing one. Read-only (mutates no coord state); `--json` returns the structured name, and `--session-id <id>` bypasses the ppid walk like `status`/`set-task`.
