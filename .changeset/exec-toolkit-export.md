---
"harnery": patch
---

The toolkit now exports `exec()` as `harnery/lib/exec`, so an embedding host can run an agent CLI under the same process-group supervision that `harn run` uses. In `processGroup` mode, a call that finishes before its deadline now stops the whole watchdog group, so no watchdog `sleep` is left running until the timeout.
