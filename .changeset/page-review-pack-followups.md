---
"harnery": minor
---

Page review pack follow-ups. `review-pack expand <dir> --tile T012 [--context <id>] [--dpr 2]`
re-captures one tile region of an existing pack at a higher device scale factor into
`contexts/<id>/tiles/<tile>@<dpr>x.png` and records it as an optional `expanded` entry on
the context record, leaving every existing tile untouched; `browse` gains
`--review-pack-expand <tile-id>` and `--device-scale-factor <n>` to do the render.
Every context with tiles now carries `contacts.png`, a box-filtered row-major grid of its
tiles with ids stamped, recorded as `contact_sheet` on the context record and linked from
`review.md`; `finalizePageReviewPack` builds a missing sheet from disk.
Gate records in a pack can carry `hits` (rectangle-bearing findings lifted from the gate's
browse envelope: runts, truncation, contrast, placeholder, image, clip, overlap, crowd, align,
gap, overflow, target size); the inspection plan maps each hit to the tiles covering it under
`gate_hits`, adds those tiles to `primary_tiles`, and `review.md` links them per gate line.
The pack schema stays `harnery-page-review/v1`: every new field is optional and additive.
