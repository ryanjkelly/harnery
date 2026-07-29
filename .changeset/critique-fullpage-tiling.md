---
"harnery": patch
---

Fix `browse --check-critique` tiling on pages taller than the viewport.

The tiler captured each tile with Playwright's `clip`, which is viewport-relative — so any band or element below the fold threw "Clipped area is either empty or outside the resulting image", and critique only worked on pages that fit one screen. It now captures one full-page screenshot and crops every tile from that image in pixel space (`tilesFromFullPage`, exported), which is below-fold-safe and keeps each tile at full resolution. The crop uses a manual RGBA row copy rather than pngjs `bitblt`, which isn't available under every runtime. Verified end to end on a ~9000px page (previously errored; now tiles and critiques clean) with regression tests over a synthetic tall buffer.
