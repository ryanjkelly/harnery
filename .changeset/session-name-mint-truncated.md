---
"harnery": patch
---

Recognize a session-name mint whose JSON reached the transcript cut short.
The PostToolUse announcer and the Stop inspector only accepted a tool result
that parsed as complete JSON, so `agents suggest-name --json | cut -c1-160`
(or any wrapper prose or tail window that clipped the object) hid the mint,
and the session-name latch could never close no matter how many times the
agent displayed the block. The detector now also accepts text that carries
the exact quoted name under `suggested_session_name` together with a true
`first_of_session`, `name_reminted`, or `session_name_retry` flag. Output
with the name but no flag, another name, or a longer name still never mints.
