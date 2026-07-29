---
"harnery": patch
---

Tell every interactive harness how to surface Harnery's suggested session name
on its first prompt.

The shared prompt hook now detects that no `set-task` call has occurred, asks
the agent to declare its focus first, and tells it to reproduce the returned
`suggested_session_name` in a fenced code block. The reminder uses the host
CLI's configured binary name, fires once per session, and skips subagents and
workflow children.
