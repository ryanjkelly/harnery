---
"harnery": patch
---

End-turn Git finalization now fails when the coordination repository is behind
its fetched upstream, when a submodule checkout is behind its parent gitlink,
or when a checkout has diverged from that gitlink. A checkout ahead of its
gitlink remains treated as another session's in-flight work rather than a
global blocker.
