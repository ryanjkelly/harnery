---
"harnery": minor
---

Add a report-only run-quality subsystem with exact pre-clamp tool-input hashes,
bounded rotation-aware evidence reads, crash-recoverable coordination, durable
per-instance snapshots, typed health transitions, validated
`coord.run_quality` configuration, and optional advisory output in
`harn agents status`. The package default remains off, and the subsystem never
changes execution verdicts.
