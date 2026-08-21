---
"harnery": minor
---

`agents health` now reports the V2 event ledger's producer health in a new
`event_ledger` section (JSON) and an `event ledger` row plus anomalies (text).
The counters are read-only and cover: open tool spans per live generation,
flagging generations whose turn has closed while spans stayed open (the orphan
signature that blocks a clean session end); pending finalization requests with
trigger, age, and allowed-open-span count; intake-spool depth with per-group
counts; diagnostics-spool counts by category with a last-24h split; and
span-count pressure against the producer-state reader's span cap. When no V2
ledger route is live the section degrades to `{ state: "unavailable" }`, and a
sub-surface that fails to read lands in `collection_errors` instead of
aborting the report.
