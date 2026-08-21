---
"harnery": patch
---

Keep the session-name display latch's remediation exemption working when the command carries a trailing stream redirect. `agents status --end-turn 2>&1` previously failed the shell-control-syntax check on the `&`, which disabled the one exemption that can close a latched turn: the latch blocked every tool call, and the end-of-turn rule required the very command the latch was blocking, so the session could satisfy neither. Redirects to `/dev/null` or another descriptor are now stripped before the check, while pipes, chaining, substitution, and redirects to a named file stay rejected.
