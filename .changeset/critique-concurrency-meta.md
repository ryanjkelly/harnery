---
"harnery": minor
---

Concurrent critique tiles and provider provenance: `runCritique` now dispatches tiles through a bounded worker pool (provider-tunable via the new optional `concurrency` property on `CritiqueProvider`, default 4) while keeping findings in tile order, and a provider may expose `meta()`, read once after the run and attached to the result as `provider_meta` so hosts can surface route, fallback, and usage provenance in the JSON envelope.
