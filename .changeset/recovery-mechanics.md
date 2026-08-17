---
"harnery": minor
---

ADR 0078 recovery mechanics land across the hook recorder, command recorder,
and session finalizer. The recorder pairs an unmatched post with a derived
`tool.requested` instead of discarding the result, suppresses late signals for
closed spans via a two-turn closed-span memory, stamps spans with native
payload turn ids (Claude Code's `prompt_id` now counts), sweeps the ending
turn's spans with derived terminals at every stop boundary and lost-stop
turn start, relieves span-cap pressure from already-ended turns at the 128
watermark, and onboards a mid-flight session (fresh epoch, lost session-start
hook) with a derived `session.started` while still refusing resurrection after
authoritative termination. Explicit-end salvage terminalizes exactly the
approved open-span set and completes the end; salvage precedes the 24-hour
expiry, and only native new work cancels a pending explicit end. A session-end
command closer gives every abandoned command span a derived
`command.completed`. Producer state upgrades in place from format 1 to 2.
