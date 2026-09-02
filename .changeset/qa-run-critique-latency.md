---
"harnery": minor
---

Record vision-call latency on each `qa-run` critique row. The critique
provider already reports per-backend call counts with p50/p95 latency in
the browse envelope's `provider_meta`; the runner read it only for the
provider label and dropped the timings. `QaRunCritiqueOutcome.latency_ms`
now carries them keyed by backend, so a straggling tile is visible in
`page-qa-result.json` rather than only to someone watching `ps`. When a
context runs several scope commands, counts sum and the percentiles keep
the slowest scope. Absent when no backend reported a call.
