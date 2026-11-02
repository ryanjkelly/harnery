---
"harnery": minor
---

Background daemons now restart when the installed Harnery code changes. Before, the presence relay client, the semantic reader and the local supervisor kept running the code they started with, so a fix that arrived by a pull or an upgrade had no effect until someone killed the old process by hand.

Each daemon now records which code it loaded: the package version, plus the checkout's HEAD commit when Harnery runs from a Git checkout. The commit is read from files, with no `git` process started. About every 30 seconds the daemon checks again. When two checks in a row see the same new code, it logs `code changed (old -> new); exiting for restart`, finishes its current work (the semantic reader completes its current model call; the relay closes its socket), and starts a replacement from the new code. A daemon whose code identity cannot be read never restarts for this reason, and a daemon stopped with its stop command does not restart.

The launchers also replace a live daemon that runs older code: `ensureRelayDaemon`, which the session hooks call, plus `ensureSemanticServiceRunning` and `ensureSupervisorRunning`. A daemon started before this release carries no code identity, so the launchers replace it once. `ensureSemanticServiceRunning` and `ensureSupervisorRunning` can now return the state `"replaced"`, and `ensureRelayDaemon` now returns its outcome instead of nothing.
