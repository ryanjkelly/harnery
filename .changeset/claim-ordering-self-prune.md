---
"harnery": patch
---

fix(coord): stop committed claims from blocking edits + make release-claim form-robust

Two coord-layer rough edges surfaced in long multi-agent sessions:

- The claim ordering rule (which enforces sorted-order acquisition to prevent
  deadlock when a fresh peer is active) computed the "highest held claim" over
  ALL of an agent's `files_touched` — including files it had already committed.
  A committed file is a finished edit, not a held lock, so over a long session
  the accumulated committed claims walled off every earlier-sorted path with
  spurious `claim.ordering_violation` blocks (no real deadlock risk, since the
  files weren't being touched). The check now prunes committed-clean claims
  lazily on the would-block path — mirroring the existing peer stale-claim
  self-heal — and only blocks when a genuinely active (uncommitted) higher claim
  remains.

- `release-claim` did an exact-string filter, but `files_touched` can hold a mix
  of absolute-under-coordRoot and canonical monorepo-relative entries, so a
  release by the "wrong" form silently no-op'd. Both sides are now normalized
  before comparison. `isFileCommittedClean` was likewise hardened to tolerate
  either path form.
