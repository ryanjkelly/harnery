---
"harnery": patch
---

Stop-enforcing adapters (Claude Code, Cursor) now receive a fresh per-prompt turn-ritual reminder from UserPromptSubmit: declare the turn focus with `agents set-task` and finish with the end-of-turn status command. Satisfying the contract up front is far cheaper than the bounce-and-retry the Stop hook otherwise forces; enforcement-only compliance was measured missing on a double-digit share of turns. Claude Code's variant asks for the status box pasted verbatim; Cursor's does not, since Cursor renders the box inline. Subagents, transient sessions, and workflow children are exempt, matching the status footer. Enable via `agent-coord prompt-context --turn-ritual-nudge <adapter>` (the shared hook path wires it automatically).
