---
"harnery": minor
---

`harn agents suggest-name <description>`: prints a session name (`Agent <you> - <description>`) for the operator to set as their harness session/tab title. Meant to run as the first thing an agent does on a new session — the agent reproduces the printed name in a fenced code block so the chat UI's Copy button hands the operator the exact string, built off the coord identity + a short summary the agent supplies, instead of typing one. Read-only (mutates no coord state); `--json` returns the structured name, and `--session-id <id>` bypasses the ppid walk like `status`/`set-task`.
