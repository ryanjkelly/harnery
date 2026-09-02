---
"harnery": minor
---

Split page QA into capture and judge through a page review pack. `qa-run`
now renders each context once into `run-<id>/pack/` (full-page screenshot,
tiles as PNG files, DOM, signature) and closes its browser, then judges every
tile of every context through one bounded in-process pool of vision calls
(`policy.critique_pool` / `--pool`), and persists signoff snapshots from the
pack's files. New `review-pack create|judge` command and `browse --review-pack`
capture flags. Result schema version 4: stage `capture`, `wall_time_ms.capture`,
`critique_pool`, `review_pack`; per-row `latency_ms` moved to `critique_pool`.
