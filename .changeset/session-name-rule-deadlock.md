---
"harnery": patch
---

Stop the session-naming rule deadlocking when a second name is minted

The `turn.stop` scan that detects the suggested session name in a reply skipped
itself once `session_name_seen_at` was stamped, without recording which name
that sighting was for. If a later `set-task` minted a different suggested name,
the scan stayed off, `session_name_present` was never emitted again, and the
Claude Code `stop-hook.session_name` rule blocked every subsequent reply — the
one remediation it asks for, reproducing the name in a fenced block, could not
satisfy it. Observed live: four consecutive turns blocked on a reply that
carried the name verbatim.

The sighting now records `session_name_seen_for`, and the scan is skipped only
while that matches the current suggested name. The projector reproduces the
field on rebuild.

This is the deadlock, not the root cause: a session that has already produced
and shown a name should not mint a second one at all. That path is still open.
