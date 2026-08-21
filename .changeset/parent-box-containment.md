---
"harnery": patch
---

Make `browse --check-clip` catch in-flow elements that escape the horizontal bounds of their nearest block parent when CSS overflow remains visible, and report the nearest boundary responsible for an overrun.
