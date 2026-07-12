---
"harnery": minor
---

`harnery/lib/http` gains `requestWithRetries()` + `backoffDelayMs()` — the retrying JSON-API primitive (per-attempt timeout, retry on 429/5xx with exponential backoff + jitter, Retry-After honored when sane, injectable retry policy / observability hook / network-error factory). Terminal non-2xx responses return `ok: false` so callers keep their own error taxonomies. Extracted from ten near-identical vendor-client copies in the first embedding host (toolkit-tier promotion per ADR 0010's demonstrated-reuse rule; a tokenCache abstraction was deliberately NOT added — no second consumer yet).
