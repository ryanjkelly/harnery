---
"harnery": minor
---

`harn browse --check-runts [selector]`: detect runts (a single word alone on a text block's last visual line) by counting words per line via per-word Range rects. Reports hits in the JSON envelope under `runts`, annotates them on the screenshot, and `--check-runts-fail` exits non-zero on any hit. Also fixes the `--no-check-visible-annotate` / `--no-check-width-annotate` / `--no-check-overflow-annotate` opt-outs, which read the wrong Commander attribute and never disabled annotation.
