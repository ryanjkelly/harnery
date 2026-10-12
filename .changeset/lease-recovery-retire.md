---
"harnery": patch
---

Stale workspace lease recovery no longer strands the winner. The winning claimant now moves its recovery directory to a private name before emptying it, so a contender's claim can no longer replace the emptied directory and fail the winner's cleanup after it already holds the lease.
