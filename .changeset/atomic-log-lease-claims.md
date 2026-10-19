---
"harnery": patch
---

Claim log and durable-history leases atomically. The owner record is written and synced in a private claim directory, then renamed into place, so a writer stopped mid-claim no longer leaves an ownerless lease that blocks every later append until someone removes it by hand. An empty lease directory left by the earlier protocol is replaced on the next claim. A lease whose owner record is empty or malformed still fails closed, and the timeout now says it has no valid owner. Release and stale recovery rename the lease aside before deleting it. A writer that found the lease released between two checks no longer reports it as the wrong type.