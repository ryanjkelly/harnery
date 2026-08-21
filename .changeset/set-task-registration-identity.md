---
"harnery": minor
---

`agents set-task` now registers a fresh session's identity from the
adapter/connector-stamped session-id environment channel when the
heartbeat-validated resolver finds nothing. A brand-new (bridge) session has
no heartbeat until its first set-task, so the validated resolver returns null
there by design and the session's first ritual command previously errored and
hard-exited without a command terminal. The env id carries the same trust as
an explicit `--session-id` argument. Adds `sessionIdentityFromEnv()` to the
agents core surface.
