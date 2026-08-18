---
"harnery": patch
---

agent-hook now no-ops a `--adapter claude-code` invocation running under a
Cursor runtime (`CURSOR_AGENT=1`). On hosts wired for both adapters, Cursor
executes the Claude Code project hooks too; recording that stray dispatch
minted a twin generation per session start plus a stream of
missing_session_start diagnostics on the claude-code producer. The skip fires
before notification sounds, pid-map writes, and V2 recording, and leaves a
`cursor-runtime-claude-adapter` breadcrumb in the hook debug log.
