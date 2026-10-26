---
"harnery": minor
---

Cap every critique invocation at 160 vision calls. `qa-run` tile budgets, `review-pack create --max-tiles`, and `browse --check-critique-max-tiles` stop at 160, and `review-pack judge` refuses a larger pack without calling the provider. Job files that asked for more than 160 tiles are now rejected. Signoff on a page whose complete review would need more than 160 tiles now passes on a sampled critique that kept every edge band, gate hit, and required scope, recorded as `coverage_mode: "sampled"` on the run's critique row and the pack's critique record.
