---
"harnery": minor
---

`harn init` now writes a `timeout` on every Codex hook entry: 20 seconds for most events and 3 for `SessionEnd`. Codex's default is 600 seconds, so a stalled hook could hold a tool call for ten minutes; a timed-out Codex hook fails open and the tool proceeds. Existing entries gain the value on the next `init`, and `harn doctor` and the session-start re-wire notice report a missing or different timeout as stale. Changing an entry changes its Codex trust hash, so re-approve the hooks in Codex after re-wiring. Other adapters are unchanged, and a hand-set timeout on their entries is preserved.
