---
"harnery": minor
---

Page review pack follow-ups. `review-pack expand <dir> --tile T012 [--context <id>] [--dpr 2]`
re-captures one tile region of an existing pack at a higher device scale factor into
`contexts/<id>/tiles/<tile>@<dpr>x.png` and records it as an optional `expanded` entry on
the context record, leaving every existing tile untouched; `browse` gains
`--review-pack-expand <tile-id>` and `--device-scale-factor <n>` to do the render.
The pack schema stays `harnery-page-review/v1`: every new field is optional and additive.
