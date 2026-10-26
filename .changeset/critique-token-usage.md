---
"harnery": minor
---

Record the tokens each critique tile spent. `CritiqueProvider` receives an optional `reportUsage` callback; the judge stores each tile's usage in `critique_pool.tile_timings[].usage`, sums it in `critique_pool.usage` (with `tiles_unreported` for backends that report nothing), and prints the totals in its log and in `review-pack judge`. `runCritique` returns the same totals as `usage`. New toolkit exports: `CritiqueUsage`, `CritiqueUsageTotals`, `addCritiqueUsage`, `sumCritiqueUsage`, and `formatCritiqueUsage`.
