---
"harnery": patch
---

Stop-hook remediation backstops: the finish sound no longer replays on stop
continuations (`stop_hook_active`), so a blocked-stop loop cannot become a
repeating alarm; consecutive blocked stops in one cycle are capped (default 5),
after which the stop is allowed so a session whose ritual evidence can never
land terminates instead of bouncing until its budget dies; and remediation
messages now carry `--session-id` so evidence from processes that don't
descend from a pid-map-registered anchor lands under the correct owner.
