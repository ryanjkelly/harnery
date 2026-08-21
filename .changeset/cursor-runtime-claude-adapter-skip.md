---
"harnery": patch
---

agent-hook now no-ops a `--adapter claude-code` invocation whose payload is
Cursor's dispatch envelope (top-level `cursor_version` field). On hosts wired
for both adapters, Cursor executes the Claude Code project hooks too, piping
them the same payload as its own hooks; recording that stray dispatch minted a
twin generation per session start, could supersede the real generation, and
flooded missing_session_start diagnostics. Detection reads the payload rather
than the environment: Cursor's hook processes do not carry CURSOR_AGENT, and a
genuine Claude Code session nested under a Cursor agent shell must not be
skipped. The skip fires before notification sounds, pid-map writes, and V2
recording, and leaves a `cursor-payload-claude-adapter` breadcrumb in the hook
debug log.
