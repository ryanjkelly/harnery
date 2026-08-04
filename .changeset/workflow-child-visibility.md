---
"harnery": patch
---

Register workflow children from the engine instead of relying on the child's own hooks.

A spawned child previously became visible in `agents list` and on the workflow run page only if its adapter fired Harnery's hooks. Headless `codex exec` fires none, so codex children were invisible for the entire duration of a stage while actively working, and the run page rendered "no live session" beside a live agent.

The engine now writes the child heartbeat itself at spawn and removes it in the `finally`, so visibility is a property of the engine rather than of whichever vendor CLI a stage happens to use. Registration is idempotent and preserves `started_at` plus any claims a hook already recorded, so hook-firing adapters keep enriching the same heartbeat. Both calls are best-effort and can never fail a spawn.
