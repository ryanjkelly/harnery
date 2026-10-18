---
"harnery": patch
---

Protect retained peer workspace authority before reclaim changes files. Claim
publication and cleanup now share recoverable path reservations, while
unrelated allocations can continue during reclaim preparation.
