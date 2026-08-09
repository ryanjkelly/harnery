---
"harnery": minor
---

Commit verdict resolves committer identity itself; `resolveOwner()` gains a validated Codex-thread tier

A host's pre-commit hook used to resolve its own `instance_id` (typically with
a hand-rolled pid-map ancestor walk) and pass it into `agent-coord verdict`.
Any copy of that logic decays independently of `resolveOwner()`, and the walk
itself has a structural blind spot: a commit spawned across a process boundary
(e.g. a Windows→WSL bridge) descends from no registered process, resolves as
unattributed, and the agent's own claims then read as a peer's. The
self-attribution rescue can never cover that case — its pid gate refuses
whenever the holder has a live pid anchor, and a live session always does. In
practice this produced runs of false-positive self-blocks that taught agents
to reach for the bypass env var as a reflex.

Two changes:

- `CommitVerdictRequest.instance_id` / `session_id` are now optional. When
  absent (or the legacy `__unattributed__` sentinel), `evaluateCommit()`
  resolves the committer via `resolveOwner()` from its own process context,
  and `CommitVerdictResult` / the verdict envelope carry the resolved
  `instance_id` back so callers can use it for logging. Hooks should send
  staged paths + bypass only and stop resolving identity themselves.

- `resolveOwner()` gains a final tier: `CODEX_THREAD_ID`, accepted only when
  it is format-safe and a heartbeat by that id exists under
  `.harnery/active/`. Codex sessions use their thread id as the heartbeat
  instance_id, and bridges forward the variable into process trees the
  pid-map walk can never reach; the heartbeat requirement keeps a stale or
  garbage value from fabricating an identity.

The `post-commit` and `post-checkout` unclaim handlers get the same
treatment: when the request omits `owner`, they resolve it in-process rather
than silently no-oping. The silent no-op was the quiet half of the bridge
failure — a bridged commit that did land never pruned its claims, so they
lingered as stale conflicts for every commit after it.

Explicitly passed identity still wins, so existing callers are unaffected.
