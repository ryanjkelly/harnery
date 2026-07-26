---
"harnery": patch
---

Identity resolution now asks the harness before it guesses from the process tree.

Every supported harness exports its session id into the environment of the
subprocess it spawns for a tool call, and every heartbeat records the session id
it was minted under. Matching the two names an agent outright. That check used to
run only for Cursor, and only after the ppid walk had already failed, so on every
other harness a pid-map row outranked it.

Rows name pids, and pids get recycled. Measured on one development machine:
`pid_max` of 99999 against roughly 100 new processes a second, so the whole pid
space turns over about every quarter hour. A row older than that can name a pid
some unrelated process now holds, and the walk resolves to whoever wrote it. That
is how `agents whoami` came to report another agent's name and file list.
Sweeping dead rows does not address this: it removes rows whose pid has exited,
and a recycled pid is alive.

Only the order changed. Session-env resolution still requires a live heartbeat
carrying that session id, so when it does not match, the walk runs exactly as
before.
