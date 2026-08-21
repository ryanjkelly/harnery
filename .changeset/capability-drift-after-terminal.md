---
"harnery": patch
---

Stop treating `health.capability_drift` as a generation-scoped event after
`session.ended`. That signal is emitted on purpose once the generation is
terminal (`generation_ended: true`); folding it through `event_after_terminal`
fail-closed the whole ledger and blocked every agent from editing.
