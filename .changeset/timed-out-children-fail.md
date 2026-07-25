---
"harnery": patch
---

Classify a workflow child killed for exceeding its timeout as failed, whatever it
exits with. `exec()` now reports `timedOut` when it fired the kill, and every
harness adapter checks that before any exit-code branch. Previously a vendor CLI
that handled the signal cleanly exited 0 and wrote no result, which was
indistinguishable from a successful empty reply: the run recorded `agent.end` with
no error, passed an empty string downstream, and surfaced the failure as a schema
error on whichever agent consumed it next.
