---
"harnery": patch
---

Strengthen diff-aware page QA before manifest enforcement. QA signatures now fingerprint opaque SVG and canvas content, so pixel-bearing edits cannot be mistaken for text-only changes. Scoped manifests fail closed when a selector matches nothing, record interaction outcome assertions, and accept an explicit component boundary for stylesheet-only changes. Reuse also rejects failed or partially covered baselines.
