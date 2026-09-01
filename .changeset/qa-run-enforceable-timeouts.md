---
"harnery": patch
---

qa-run timeouts are now enforceable. The executor spawns each command detached into its own process group and escalates at the deadline (group SIGTERM, then SIGKILL after a 5s grace), settles on exit instead of waiting for pipes an orphaned grandchild may hold open, and reports a timed-out command as an error even if it later exited 0. A new `policy.run_deadline_ms` (default 900000) bounds the whole run: past it, remaining commands are skipped, a `deadline` blocker is recorded, the result finalizes incomplete, and the admission slot is released.
