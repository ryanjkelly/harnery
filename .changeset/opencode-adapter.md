---
"harnery": minor
---

Add first-class OpenCode (V2) support. OpenCode joins the workflow adapter
registry (`opencode run --format json` spawner, offline bench fixture, effort
validation) and the Event Ledger V3 adapter census with its own capability
profile. Because OpenCode V2 intercepts lifecycle events through an in-process
plugin rather than a settings-file hook map, the adapter spec carries an
install mode; `harn init --adapter opencode` will install a Harnery plugin and
register it in `opencode.json` instead of writing a hooks map, and skips the
CLAUDE.md shim and skills mirror because OpenCode reads `AGENTS.md` and
`.agents/skills` natively. This change adds an adapter capability digest, so
`harn init` archives the prior Event Ledger V3 epoch and mints a new one; the
three published digests stay byte-identical. Enforced Stop re-prompting,
SQLite-backed context telemetry, and the shipped plugin package are follow-ups.
