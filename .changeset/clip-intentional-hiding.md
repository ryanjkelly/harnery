---
"harnery": patch
---

browse checks: the clip gate now excludes two intentional-hiding idioms instead of failing on them. Visually-hidden (sr-only) content is a ~1px absolutely-positioned box whose clipping IS the accessibility pattern — its box is not zero-area and the legacy `clip: rect(0,0,0,0)` it relies on is not an overflow style, so nothing recognized it and every accessible page failed the gate. Single-line ellipsis truncation (`text-overflow: ellipsis` + nowrap + hidden overflow) is deliberate design owned by the dedicated truncation check. Both now land in the result's `excluded` list with audit reasons (`visually-hidden`, `ellipsis-truncation`) rather than in `issues`.
