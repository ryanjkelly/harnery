---
"harnery": patch
---

The browse layout lint's clip check measures text at its line box. When a fixed line-height is shorter than the font's content area (common with Segoe UI, the Windows `system-ui` font), the text box overhangs the line by a fraction of a pixel on each side, and every tight line inside an `overflow: hidden` box was reported as clipped. Text that really runs past a clipping container is still reported.
