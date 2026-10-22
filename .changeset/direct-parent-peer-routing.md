---
"harnery": minor
---

Peer messages now copy a verified, safely addressable direct parent and report
each recipient's actual result. Exact generation checks and stable operation
IDs prevent retries from selecting a different task. Replay-only attempts keep
missing history unknown, and a parent copy that exceeds the existing 4000-byte
limit fails explicitly. Agent show and status expose the selected task's parent
relationship and its evidence source without changing claim or lifecycle
authority.
