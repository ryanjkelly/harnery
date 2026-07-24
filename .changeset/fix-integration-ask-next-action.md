---
"harnery": patch
---

Point `workflow approvals approve` at re-running integration prepare after an
integration ASK (not `workflow resume`), and use `resolveBinName()` in that
next-action hint.
