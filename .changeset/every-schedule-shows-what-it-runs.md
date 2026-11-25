---
"harnery": minor
---

Every schedule record can now carry `work`: what it runs. OS timers give each systemd `ExecStart=` line and crontab entries their command text; T3 Code tasks and Codex app automations give their prompt, model and effort. One shared secret redactor masks anything that looks like a password, key or token as `‹redacted›` before the text enters a record, and `work.redacted` says when it did. A Harnery job's commands and agent moved from `job` into `work`; `job` keeps enrollment, owner, limits and the newest run. Environment variable values, inbox text and webhook secrets are still never read.
