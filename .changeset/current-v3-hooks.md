---
"harnery": minor
---

Bring the installed Claude Code, Cursor, and Codex hook sets up to their current
native lifecycle contracts. `harn init` now repairs stale, duplicated,
misplaced, and retired Harnery handlers without removing unrelated commands
from mixed hook groups. `harn init --check` verifies hooks, skills, instructions,
managed Git hooks, and the V3 runtime profile. V3 now admits Codex session-end
events and verified Cursor pre-compaction events, and init refreshes an
incompatible immutable epoch while preserving its archived ledger.

Workflow children no longer receive operator-only SessionStart remediation
context, live adapter attestations allow the bounded setup rituals required by
host repositories, and every package build starts from a clean V3-only `dist/`
tree so deleted ledger generations cannot leak into a tarball.
