---
"harnery": minor
---

The canonical event ledger `.harnery/events.ndjson` now rotates by size instead of growing without bound. Both append paths (agent-hooks and agent-coord) roll the active file to a dated `events-YYYY-MM-DD.ndjson` archive once it crosses a byte cap (`HARNERY_EVENTS_ROLL_BYTES`, default 256 MiB), under an `O_EXCL` roll-lock so concurrent appenders never double-rename. Archives are kept, so the immutable audit trail is preserved. Readers span the boundary transparently: `scanEventsTail` continues from the active file into archives newest-first, and the web identity index folds each archive exactly once so agent names survive a roll. This removes the failure class where a reader that whole-file-read the ledger crashed on V8's ~512MB max string length once it grew large enough. Design: ADR 0009.
