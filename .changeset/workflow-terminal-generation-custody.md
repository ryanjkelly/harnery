---
"harnery": patch
---

Keep workflow terminal writes and cache cleanup bound to the generation captured at dispatch. Fail the run when terminal confirmation fails, reject stale authority mutations and pending replay, and recover held cache cleanup after process death without consuming a replacement generation.
