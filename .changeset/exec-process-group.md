---
"harnery": patch
---

`harn run` now stops a timed-out agent CLI together with every process it started. The four spawn adapters (Claude Code, Codex, Cursor, OpenCode) start their child in its own process group and, on timeout, send the group SIGTERM, wait a grace period, then send SIGKILL; a detached watchdog enforces the same deadline even when the parent's event loop is busy, and the call returns when the child exits instead of waiting for pipes a leftover descendant holds. Live groups are also stopped when the parent exits or receives SIGINT, SIGTERM or SIGHUP. The toolkit's `exec()` gains the `processGroup`, `maxOutputBytes` and `raw` options and reports `signal` and `outputLimitExceeded`; callers that pass none of them behave as before. On Windows the option keeps the single-child kill.
