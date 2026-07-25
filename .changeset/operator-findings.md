---
"harnery": minor
---

Add operator findings at the durable-work review gate. `work reopen` now accepts
`--finding <text>` (repeatable); each finding is recorded on the reopen event and
carried into the next attempt's frozen context as `attempt.findings`, so the team
can act on a correction the reviewer missed. Acceptance fails closed while a
finding is open: `work accept` requires `--dispose <id>=fixed` or
`--dispose <id>=deferred:<reason>` for each one, and the dispositions are recorded
on the acceptance event. Existing attempt contexts without findings stay canonical.
