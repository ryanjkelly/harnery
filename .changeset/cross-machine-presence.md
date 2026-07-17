---
"harnery": minor
---

Cross-machine session presence (ADR 0016), phase 1: the git-refs transport. Each machine publishes its live sessions (names, tasks, files held) as a parentless commit force-pushed to `refs/harnery/presence/<machine>` on origin, and fetches peers' refs on a throttled hook cadence — zero configuration, repo access is the only credential. Remote sessions render in `agents list` (relation=remote rows with a `machine` field), the `agents status` peers line (`Name @machine`), and the SessionStart/prompt peer tables, advisory-only. New subcommands: `presence publish|fetch|peers`. Opt out via `.harnery/config.jsonc` `{"presence":{"enabled":false}}` or `HARNERY_PRESENCE=0`; everything is fail-silent (no origin / no network / refused refs → no remote peers, never a broken hook).
