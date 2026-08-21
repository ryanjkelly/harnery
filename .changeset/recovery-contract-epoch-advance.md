---
"harnery": minor
---

Event ledger V2 gains the ADR 0078 recovery contract: `tool.requested`,
`tool.completed`, and `command.completed` accept an optional `recovery` block
(`reason` + `requested_event_id`) marking machinery-minted recovery events,
with validator-enforced rules (derived attestation, unknown outcome,
per-event-type reason binding). The schema digest advances, and
`harn ledger-v2 advance-epoch` performs the resulting ledger epoch advance in
one idempotent, crash-resumable pass: quiesce the ready spool, carry undrained
intake rows, archive the prior epoch read-only under its genesis ID, then
install and activate the new candidate anchored to the archived ledger file.
