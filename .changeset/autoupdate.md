---
"harnery": minor
---

New opt-in project self-update, fired by agent activity instead of a
scheduler. With `"autoUpdate": { "enabled": true, "steps": [...] }` in
`.harnery/config.jsonc`, every prompt, session start, and host CLI command
built on `createHarneryProgram` calls a tick whose hot path is one stat of a
throttle stamp. When the stamp is older than `checkMinutes` (default 15), a
detached run compares HEAD with the upstream branch through `git ls-remote`
(no fetch), fingerprints the configured `watch` paths, and runs the project's
own `steps` only when the branch moved, a watched path changed, or the last
run failed. `dailySteps` run at most once a day. A step's `harnery-notice:`
output lines reach each agent session once, through the prompt and
session-start hooks, as `Auto-update:` lines; exit code 75 marks a run that
needs a person. Harnery also adds a notice when an update changed agent
instructions or hook settings. New `autoupdate status|check|run` command, new
config keys under `autoUpdate`, and `readAutoUpdateConfig()` in `core/config`.
Projects without the section are unchanged.
