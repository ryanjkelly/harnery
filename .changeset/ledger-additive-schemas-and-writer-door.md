---
"harnery": minor
---

The V3 event ledger keeps its epoch across additive schema changes and no longer lets one bad row stop coordination for every session (ADR 0245).

- Additive event-schema changes continue in the same epoch. A committed schema lineage tells each runtime which schemas share an epoch, and `ledger.schema_advanced` is no longer written.
- A runtime that finds a schema it does not know blocks itself with `epoch_schema_unknown`. It appends nothing and never replaces the epoch. `harn init` never replaces such an epoch either.
- New epochs use genesis manifest version 2, which releases before this one refuse; their hooks, commands and rotation stop without replacing the epoch.
- The writer appends a queued row only when the reader would accept it. A valid row it cannot append yet stays in the queue and `writeEventV3` returns `waiting` with a reason; a queued file that can never be appended is renamed aside, kept, and reported as `set_aside`. `harn agents health` reports both by generation and reason, and `harn agents set-task` tells a session whose rows wait.
- `harn ledger-v3 status` reports the genesis schema digest, the digests present in the epoch and the compatibility verdict.
- Command events that run outside a turn, such as session-start hooks, are recorded against their session instead of being dropped.

**Breaking for scripts:** `harn ledger-v3 initialize --force-new-epoch` now only previews unless you add `--yes`. It is the only command that replaces an epoch the runtime cannot serve. Rolling back to an older release after this one has written to an epoch needs one such replacement, run with the older release.
