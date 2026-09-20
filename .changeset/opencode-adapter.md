---
"harnery": minor
---

Add first-class OpenCode (V2) support. OpenCode joins the workflow adapter
registry (`opencode run --format json` spawner, offline bench fixture, effort
validation) and the Event Ledger V3 adapter census with its own capability
profile. Because OpenCode V2 intercepts lifecycle events through an in-process
plugin rather than a settings-file hook map, the adapter spec carries an
install mode: `harn init --adapter opencode` installs the Harnery OpenCode
plugin (`opencode-plugin/`, copied to `.opencode/plugins/harnery/` under an
ownership header, auto-discovered so `opencode.json` is never edited) instead of
writing a hooks map, and skips the CLAUDE.md shim and skills mirror because
OpenCode reads `AGENTS.md` and `.agents/skills` natively. The plugin bridges
prompt, tool, permission, compaction, and session-bus events to `agent-hook
--adapter opencode`, injects returned context through OpenCode's own channels,
rejects a denied tool call, and stamps `OPENCODE_SESSION_ID` into tool shells.
`init --check`, `deinit`, `doctor`, and the wiring summary understand the plugin
install mode, and every `--adapter` option accepts `opencode`. Stop verdicts
are observe-only for OpenCode, like Codex. This change adds an adapter
capability digest, so `harn init` archives the prior Event Ledger V3 epoch and
mints a new one; the three published digests stay byte-identical. Enforced Stop
re-prompting and SQLite-backed context telemetry are follow-ups.
