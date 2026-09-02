---
"harnery": patch
---

Keep a live session recoverable when the V3 ledger rotates mid-turn. A size
rotation (ADR 0137) archives every producer state, and the session re-onboards
on its next hook through mid-flight onboarding (ADR 0078). Two gaps left that
session stranded until a human submitted the next prompt. Onboarding only
opened a turn for a user prompt, so a session onboarded by a tool hook had a
generation with no current turn: command telemetry refused every join with
`turn_not_started` and the end-of-turn ritual could not close. And onboarding
inherited the hook's deferred drain, so the derived `session.started` sat in
the spool where the coordination view could not see it, and `set-task`,
`status --end-turn`, and `heal` all reported no live generation. Onboarding now
commits its own events eagerly and, when the triggering signal is one an
adapter can only deliver inside a turn, opens a derived turn that keeps the
payload's native turn id. The session recovers on its very next tool call.
