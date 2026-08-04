---
"harnery": patch
---

fix(stop-hook): end the Cursor end-of-turn remediation loop

A Stop block on Cursor re-prompts by auto-submitting the message as a new user
turn. Because repairing the ritual runs a command, that new turn needed both
ritual signals again while the signal from the previous turn fell outside the
window, so satisfying one rule failed the other and the two alternated until
Cursor's followup cap.

The Stop verdict now recognizes a turn Harnery itself opened, via a machine
marker at the head of the followup message, and anchors the window at the last
prompt a human wrote. Ritual signals accumulate across a remediation chain, so
each repair makes progress and the chain terminates. The Cursor followup also
names both commands now, which reduces the common case to one followup.

Claude Code (exit-2, same turn) and Codex (observe-only) are unchanged. See ADR
0053.
