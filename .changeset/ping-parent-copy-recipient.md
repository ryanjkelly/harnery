---
"harnery": patch
---

`agents ping` now says whose parent a skipped parent copy refers to. The copy goes to the recipient's parent, so pinging a top-level session from a delegated worker printed `skipped (native_child_identity_unavailable)`, which read like a fault in the sender's own parent link. The line now reads `skipped; no verified parent for agent-<recipient> (...)`. The JSON output is unchanged.
