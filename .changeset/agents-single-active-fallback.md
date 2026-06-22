---
"harnery": patch
---

fix(agents): resolve the sole live agent when the ppid walk finds nothing

`agents status` / `set-task` (and `whoami`) previously failed with
`no_pidmap_entry` whenever the ppid walk couldn't climb back to a pid-map
anchor — notably from a Bash-tool subshell, where the stop hook's own
end-of-turn nudge to run `<bin> agents status` would itself error unless the
caller passed `--session-id`.

Owner resolution now adds a final fallback: when env + ppid-walk both miss and
exactly one agent is live in the coord root (within the 600s heartbeat
freshness window), that agent is unambiguously self, so it resolves to it.
With zero or 2+ live agents it stays null and the explicit `--session-id`
escape hatch is still required. `whoami` reports the new resolution source as
`active_singleton`.
