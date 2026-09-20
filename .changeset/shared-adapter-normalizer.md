---
"harnery": patch
---

Replace the seven copied platform-to-adapter normalizers with one shared
implementation next to the `Adapter` union. Three of the copies did not know
`opencode` and silently judged an OpenCode session as Claude Code in claim and
commit conflicts and in `agent-coord` repairs. Both adapter censuses are now
checked for completeness at compile time, an unrecognized platform value is
reported on stderr instead of being swallowed, and `harn checkpoint` accepts
every workflow adapter.
