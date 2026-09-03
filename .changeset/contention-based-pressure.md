---
"harnery": minor
---

Derive resource pressure from contention evidence instead of finding severity,
and stop control-state reads from scaling with ledger history.

The assessment now comes from one pure policy module. State is set only by
signals that show a shared resource is actually contended: pressure-stall
averages, a new out-of-memory kill, swap-out rate, direct reclaim, exhausted
memory with exhausted swap, and exhausted storage. Findings that name who holds
a resource are carried as contributors and can no longer raise the state, so a
single large process no longer tells every agent to stop working while the
kernel reports no stalls. Entry and exit use different thresholds with a dwell,
a counter reset or observer restart starts a new baseline, and a dimension the
platform does not expose is reported as unavailable rather than healthy. New
`/proc/vmstat` rates (swap in and out, direct reclaim, major faults) back the
memory signals on Linux. `resources status`, the prompt notice, the dashboard,
`diagnostics explain`, bundle replay, and shadow admission all read the same
published assessment, and every threshold now lives in one policy object that
is included in the bundle threshold digest.

The authenticated storage witness now covers a validated candidate epoch, so a
hook no longer parses the whole active segment when the control state is
`candidate`. Candidate creation and activation became one locked step,
initialization can resume a stranded candidate, the route resolver repairs one
at its next boundary, size-based rotation applies to a candidate epoch, and a
non-active control state opens a diagnostic finding instead of showing up only
in an initialization check.

Breaking: diagnostic advice moves to schema version 2 and carries the
assessment plus the prior hysteresis state; there is no version 1 reader. The
resource snapshot moves to schema version 2 and supervisor findings to version
3, which adds a required finding class.
