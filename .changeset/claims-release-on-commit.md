---
"harnery": patch
---

Claims actually release on commit now. The post-commit prune chain was broken
in three compounding ways, so agents appeared to hold files long after
shipping them:

1. `groupUnclaim` (the post-commit / post-checkout prune) compared paths with
   an exact-string filter, but `files_touched` holds a mix of canonical
   repo-relative entries (written by the claim guard) and absolute paths
   (projected from raw Edit/Write tool_input) — the mixed-form case silently
   no-op'd. It now normalizes both sides, releases every form of the path in
   one pass, and reports which heartbeats actually dropped it.
2. The prune was file-only: no `claim.release` event was emitted, so even a
   successful prune resurrected on the next projector replay.
   `agent-coord post-commit` / `post-checkout` now emit the durable event per
   actual removal (reasons `commit` / `checkout`), and the conflict-time
   stale-claim self-heal (`pruneClaimFromPeer`) got the same normalization +
   event treatment.
3. The heartbeat projector stored the raw absolute tool_input path, so every
   guarded edit double-counted as two claims (relative + absolute). It now
   canonicalizes to repo-relative before storing.
