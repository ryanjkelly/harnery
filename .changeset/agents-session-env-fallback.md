---
"harnery": patch
---

fix(agents): resolve owner by harness session-id env when the ppid walk misses

The single-active-agent fallback closed the common case, but `agents status` /
`set-task` / `whoami` still failed with `no_pidmap_entry` from a Bash-tool
subshell whenever 2+ agents were live in the coord root, since the singleton
fallback stays null when it can't tell which agent is self.

Owner resolution now adds a `session_env` fallback ahead of the singleton one:
when env + ppid-walk both miss, it reads the harness-provided session id from
the environment (`CLAUDE_CODE_SESSION_ID`, `CURSOR_SESSION_ID`,
`CODEX_SESSION_ID`, or the `HARNERY_AGENT_COORD_SESSION_ID` override) and
matches it against the `session_id` recorded on each live heartbeat (same 600s
freshness window). The match is unambiguous even with many agents live, so the
stop hook's end-of-turn nudge to run `<bin> agents status` now works without
`--session-id` in the multi-agent case. `whoami` reports the new resolution
source as `session_env`.
