---
"harnery": patch
---

Keep released write claims in the end-turn Git check. The V3 coordination view now lists each live session's released paths, and the closing check refuses while a commit touching a released or handed-off path is missing from every remote, or a submodule commit touching it is not recorded in the parent gitlink. A released path still blocks no peer and carries no dirty-file obligation. Handed-off paths use the same precise check, so a peer's unpushed commit to an unrelated path no longer blocks the sender.
