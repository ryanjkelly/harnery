---
"harnery": patch
---

Claim releases are now stream-durable. `agent-coord release-claim` and
`kill-heartbeat` mutated only the live heartbeat file and emitted no event, so
the heartbeat projector — which rebuilds `files_touched` by replaying the
permanent `Edit`/`Write` events — silently reverted every release on the next
full replay (a lagging-cursor `replayAll` drain): released claims returned
within seconds, and a killed heartbeat resurrected with all its claims. Both
handlers now append a canonical `claim.release` event (reason `explicit` for a
release, `heal` per held path on a kill) so every future replay subtracts the
path too; the projector's `claim.release` case additionally normalizes
absolute-under-coordRoot vs repo-relative path forms before comparing (the
exact-string filter no-op'd on the mismatch). Idempotent re-releases of a path
not held stay quiet. Every release surface inherits the fix — `agents
release-claim`, the web UI release button, the hooks' auto-release-on-failure,
and `agents heal --kind kill`.
