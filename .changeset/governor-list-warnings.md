---
"harnery": patch
---

Durable governor and work listings now skip unreadable records and report a warning for each one while direct record loads stay strict. Governor creation also rejects specialist profile keys that the frozen governor schema does not support.
