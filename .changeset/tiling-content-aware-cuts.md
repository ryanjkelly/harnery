---
"harnery": minor
---

Content-aware critique tiling: band seams now snap into content gaps instead of cutting at fixed offsets. The browser client extracts visual atoms (text line boxes, replaced elements, small bordered boxes), and each seam lands at the cheapest cut within a bounded window above its target — clean seams carry a 16px margin instead of the full 120px overlap, while unavoidable cuts keep the overlap and the rubric's artifact mitigation. Selector-mode tiles taller than the band budget are banded internally instead of shipping as one over-tall tile the provider would downscale. New `harnery/lib/browser` exports: `snappedBandRects`, `bandOversizedRect`, `cutCost`, `VisualAtom`, `SnapSeam`, `SnapOptions`; `tilesFromFullPage` accepts an optional `atoms` input and falls back to fixed bands without it.
