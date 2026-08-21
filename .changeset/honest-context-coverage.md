---
"harnery": minor
---

Report explicit V3 context coverage states at completed-turn boundaries. Current
Claude Code, Codex, and Cursor native hooks now declare context usage unsupported
unless a terminal payload supplies both used and limit tokens, and latency
projections preserve partial and missing reasons without storing content.
