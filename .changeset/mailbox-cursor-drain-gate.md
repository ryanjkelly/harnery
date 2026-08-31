---
"harnery": patch
---

Do not drain an agent's mailbox on a prompt an adapter cannot deliver. Cursor's prompt hook can allow or block a turn but cannot inject model context, so rendering messages there removed them from the queue and then discarded the output. Those sessions now keep their messages until SessionStart, which Cursor does deliver. The capability is exported as `canReceiveContext` so any future consumer of state-spending context has one place to check.
