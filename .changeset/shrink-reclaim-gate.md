---
"harnery": patch
---

Workspace reclaim checks liveness, ownership and retained peers once before taking its leases, relies on ordinary cleanup's checks under those leases, and checks liveness once more immediately before the destructive reset. The reclaim preview reads lease holders through the lease module's validated owner reader.
