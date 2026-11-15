---
"harnery": minor
---

Add `agents handoff <path>... --to <name>` and `agents handoff accept <path>...`. A session can offer claimed, dirty paths to a named live peer; once the peer accepts, the paths leave the sender's end-turn dirty-file check and join the receiver's, while the sender's own commits must still be pushed. Both steps are recorded as a new additive `coord.handoff_changed` V3 event. Finalization refusals now name peers that also hold a dirty path and print the handoff command, the edit and commit guards name it beside the bypass variable, the receiver's status box shows waiting offers, and `agents lifecycle done` releases claims on clean paths itself.
