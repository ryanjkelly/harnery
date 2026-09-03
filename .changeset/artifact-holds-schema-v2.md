---
"harnery": minor
---

Add artifact schema v2 with durable, owner-scoped holds. Held work survives expiry,
byte-budget cleanup, release, and nested review-pack cleanup. Clients can create
an artifact with its initial holds already recorded and check hold capabilities
before starting work. Manifest changes and deletion share a filesystem lock.

Existing v1 manifests require the explicit, dry-run-first `artifacts migrate`
command, which preserves each original manifest before adding an empty holds
array. Unsupported manifests remain protected. The public manifest type is now
`ArtifactManifestV2`; clients must update their imports.
