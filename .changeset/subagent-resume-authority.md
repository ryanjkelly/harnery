---
"harnery": patch
---

Sending a message to a running background subagent no longer strips the parent session's coordination authority. Claude Code fires SubagentStart again when a message resumes a subagent, and the recorder wrote a second `agent.started` for the already-open delegation. The reducer counted that as a conflicting duplicate start, which blocked authority for the whole parent generation, so `set-task` failed with `heartbeat_missing` and `status --end-turn` with `no_live_generation`. The recorder now suppresses a repeated start for an open delegation and records a `duplicate_subagent_start_suppressed` diagnostic. The reducer also accepts an exact repeat with the same parent and child as a resume, which restores sessions whose ledger already holds such repeats. A repeat that names a different child still blocks authority.
