---
"harnery": patch
---

A correct session-name display now closes the latch on Cursor.

Three changes. A leading fenced block accepts any single-word fence label, so a
title shown in a ```txt or ```markdown fence counts; the block must still be the
reply's first content and hold exactly the title on one line, and a closing fence
must match the opening run. The title the agent was last instructed to display is
recorded and its display also satisfies the latch, so a suggestion that changes
after the instruction went out cannot strand a session. The hook log now
separates "no pending title" from "the reply did not open with the block", and
records every session-name denial.

Cursor sessions could previously stay latched for their whole life: its only
closing surfaces are one PreToolUse narration sample and one completed reply, and
when both missed nothing could reopen the window.
