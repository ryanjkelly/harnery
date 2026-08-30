---
"harnery": patch
---

Fail `agents status --end-turn` and withhold its status box when the required
`coord.status_observed` event cannot be recorded, so agents can retry the
command instead of losing a turn to the Stop hook.
