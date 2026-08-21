---
"harnery": minor
---

Replace every event-recording, coordination-authority, workflow, CLI, web, and
downstream runtime path with the canonical V2 ledger. Harnery now initializes a
V2 epoch automatically, validates one generated TypeBox and JSON Schema
contract, uses deterministic canonicalization and keyed fingerprints, records
explicit spans and causal links, and fails closed when V2 authority is missing
or invalid.

This is a breaking removal of the legacy event contract, its readers, writers,
rotators, projectors, cutover commands, rollback paths, generated mirrors, and
compatibility tests. Historical log files are left untouched, but no shipped
runtime opens or appends to them.
