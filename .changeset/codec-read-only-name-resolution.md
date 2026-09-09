---
"harnery": minor
---

Keep name resolution out of the config and process-launching graph.

`readLiveNames` and `assignName` now require an explicit `freshnessSecs`
instead of falling back to `coordFreshnessSeconds()`. That fallback made
every consumer of the name pool import `core/config.ts`, which resolves the
coordination root through a `git rev-parse` spawn. The dashboard's read-only
Codec director reaches name resolution, so its dependency-boundary guard
failed on the transitive `node:child_process` import.

Callers that assign names already hold the coordination root and now pass the
configured freshness themselves. Resolution behavior is unchanged.
