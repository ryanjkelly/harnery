---
"harnery": patch
---

Codec keeps a declared task on stale sessions, and mid-flight sessions get a pool name instead of an 8-character id. Task prose still lives only in the generation cache; evidence panels now inherit it from that cache. Unnamed hook sessions stamp the same pool name onto the cache that SessionStart would have assigned.
