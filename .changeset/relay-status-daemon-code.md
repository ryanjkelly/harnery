---
"harnery": patch
---

`presence relay-status` now reports the code identity the relay daemon recorded (`daemon.code`) and whether a running daemon runs the installed code (`daemon.code_current`). A daemon started before code identity existed records none, never replaces itself, and can keep publishing a stale view after an update; the summary line now names it and says to stop that pid so the next session start or Stop hook launches a current daemon.
