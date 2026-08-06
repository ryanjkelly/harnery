---
"harnery": minor
---

Recorded fork lineage. A branched conversation is now a first-class recorded
relationship instead of an inference: Claude Code forks are detected from
preserved message uuids at the tool.pre_use heal (the fork never fires its own
SessionStart), `forked_from` lands on the branch's name-history row and rides
the heal event for replay convergence, session-start context names the parent
("branched from agent-X's session…") with a generic inherited-name clause as
the fallback, and `agents identity assume` refuses a fork ancestor
(`identity_is_ancestor`) unless `--force-ancestor` marks deliberate
succession. Also fixes the pre-existing hole where a forked Claude Code
session ran as a permanently nameless heartbeat: healHeartbeat now mints a
pool name for a main session with no history. `assign-name` and
`heal-heartbeat` accept `--forked-from` for adapters that can supply a parent
id directly.
