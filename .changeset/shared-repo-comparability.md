---
"harnery": patch
---

Context recovery and workflow proofs now decide whether two repository snapshots can be compared through one shared check, `repoComparisonProblems`, which replaces `observationsComparable`. A proof whose snapshots are truncated or lack a branch, HEAD or matching root now reports all repository drift as unknown, the same rule recovery briefings already follow.
