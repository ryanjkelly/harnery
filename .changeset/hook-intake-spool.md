---
"harnery": minor
---

Hook signals now survive producer-state lease contention. Each signal is
appended to a durable per-session intake spool before any producer state is
read or validated; whichever process holds the session's state lease drains
the spool in append order and rescans until an empty pass, and the
finalization reconciler drains groups whose final appender never acquired the
lease. `recordHookSignalV2` gains a `spooled` result state and a bounded lease
retry, `unpairable_tool` results now carry a machine-readable reason, and
signals that cannot become ledger events (unpairable posts, missing session
start, unreadable or gate-mismatched intake records, rejected command emits)
are preserved in an owner-only diagnostics spool with raw content fields
reduced to byte counts and digests instead of being silently discarded.
