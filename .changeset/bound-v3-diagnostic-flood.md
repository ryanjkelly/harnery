---
"harnery": patch
---

Bound duplicate V3 producer-diagnostic file creation. While a key is below 32
loose exemplars for a UTC day, the writer adds a key digest suffix to each
loose filename and the gate counts those names from the directory. No summary
or lease state is created below the bound. At or above the bound, a short
per-key lease protects one summary for that key and day. The summary preserves
the logical count, first and last times, represented bytes, hourly buckets for
that UTC day, bounded exemplar digests, and approved metadata. Concurrent
writers may admit a few extra exemplars because the flood stop is approximate,
not an exact quota.

Coalesced writes return the summary path. Mitigation failures fail open to a
loose write and append a best-effort health record to the size-capped,
append-only `mitigation-health.ndjson` log. Existing loose diagnostics are
never moved, rewritten, deleted, or reclassified. `agents health` and `doctor`
report logical occurrences from loose files plus summaries, with physical
counts shown separately. `HARNERY_V3_DIAGNOSTIC_SUMMARIES=0` disables the gate.

Storage-catalog and support-pack registration will be added when ADR 0129 and
ADR 0131 are implemented. This patch does not claim those registrations.
