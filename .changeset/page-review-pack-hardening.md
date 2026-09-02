---
"harnery": minor
---

Page review pack hardening. Every pack now carries `retention` and expires 90
minutes after its judge finishes (after capture when no judge runs); the whole
pack directory is deleted by `review-pack clean` (preview by default, `--yes`
to delete) or, when `review_pack.auto_clean` is on, before the next `qa-run` or
`review-pack create`, leaving only `pack-expired.json`. `--retain <minutes>`
on `qa-run`, `review-pack create`, and `review-pack judge` overrides the
default; `policy.review_pack_retention_minutes` does the same in a job.
Capture fidelity is checked while the capture browser is open: two probe bands
are re-shot by scrolling and compared with the full-page screenshot, and a
context whose full-page capture is wrong is tiled from scrolled band captures
instead (`capture_fidelity` on the context record). The judge still opens no
browser; each tile's rubric now carries its band position and capture source.
Gate hits below the tile cap get their own `hit band` tiles
(`browse --review-pack-hit-rect`, wired from `qa-run`). Reviewer findings and
dispositions have a command surface: `review-pack findings add`,
`review-pack disposition`, and `review-pack verdict` (writes
`evidence/verdict.json` and a reviewed outcome beside the machine outcome).
`review-pack list` and `review-pack show` inspect packs on disk. The gate
stage skips its duplicate full-page PNG when a capture stage runs, and the
pack's DOM is stored gzip-compressed. The pack schema stays
`harnery-page-review/v1`; every new field is optional.
