---
"harnery": minor
---

Add `harn schedule`. `harn schedule list` shows the schedules held by T3 Code, the Codex app, systemd timers, crontab and agents' tool calls in one list, with each source's coverage. The scheduler runs jobs from a tracked `.harnery/schedules.jsonc` once per due time on machines where they are enrolled: Harnery runs each job's fixed gather commands, a read-only agent can judge the output, and an opt-in systemd user timer runs jobs with every session closed.
