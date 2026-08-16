---
"harnery": minor
---

Add the inactive event-ledger V2 foundation: a strict generated TypeBox
contract, deterministic schema digest, UUIDv7 identities, canonical HMAC
fingerprints, a spool-first writer, and a validating reader. The new API writes
only when explicitly called and does not change the live V1 recording path.
