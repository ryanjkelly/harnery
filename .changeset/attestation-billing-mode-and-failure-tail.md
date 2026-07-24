---
"harnery": minor
---

Record the billing mode an attestation ran under, and stop truncating vendor
failures from the wrong end.

`harn harness attest` gains `--subscription-only`, matching
`workflow run --subscription-only` and the repo default in `config.jsonc`. The
mode is stored on the record and invalidates it when it differs, because a child
that may fall back to an API key can succeed where one restricted to its stored
login fails. Attestation records move to schema version 2; existing records are
rejected and should be re-recorded.

All three spawn adapters previously reported the FIRST 500 characters of a
failed child's output. A vendor CLI prints its banner and resolved config first
and the reason it failed last, so that reliably preserved the banner and
discarded the cause: a child that died with "your workspace is out of credits"
reported a cosmetic startup warning instead. Failure text is now tail-preserving
and includes both streams, since which one carries the reason varies by vendor.
