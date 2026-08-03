---
"harnery": patch
---

Teach `browse --check-crowd` to treat wrappers of panels as peers.

A card grid or flow of cards wrapped in a borderless container sitting flush
against the next card used to pass crowd: only leaf panels counted, so the
wrapper was invisible and the seam went unmeasured. Crowd peers are now leaf
panels **or** in-flow siblings that contain at least one panel. Separation uses
the nearest face panels inside each peer (not the wrapper boxes), so a tall
section with a card near the top and prose below does not false-fail. Issues
carry `beforeKind` / `afterKind` (`panel` | `composite`) so the JSON says when
a composite peer was involved.
