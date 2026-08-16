---
"harnery": minor
---

Replace the canonical event ledger with a private V2 contract and a hard
cutover. V2 adds one generated TypeBox and JSON Schema contract, deterministic
canonicalization and keyed fingerprints, UUIDv7 identities, explicit spans and
causal links, adapter capability attestations, a spool-first concurrent writer,
strict readers, V2-only coordination authority, safe web projections, and an
activation-bound run-quality collector.

The release also adds crash-recoverable candidate, activation, and rollback
commands. They seal V1 without rewriting it, fence stale V1 writers, snapshot
disposable projections, archive a failed V2 epoch whole, and restore an exact V1
continuation. Candidate canaries remain evidence-ineligible, and a separately
approved activation event is the only boundary for a new corpus.
