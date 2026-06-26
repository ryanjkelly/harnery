---
"harnery": minor
---

feat(doctor): detect harness-hook wiring drift after an upgrade + nudge to re-init

When a release adds or renames a hook event, an existing project's harness
settings file keeps the old wiring until `harn init` is re-run — and nothing
told you. Updating the package alone never surfaced it, because wired hooks call
the `agent-hook` binary (so code fixes land for free), but newly-added events
aren't wired until init runs again.

Two non-intrusive surfaces now catch this, sharing one read-only comparison
against `HARNESS_SPECS`:

- `harn doctor` gains a `harness hooks` check: `wired + current`, or a warning
  naming the missing (and orphaned) `agent-hook` subcommands with the exact
  remedy.
- SessionStart emits a one-line nudge when wiring is out of date, naming the
  missing hook(s) and the harnery version.

Both fire only for a harness the project has already opted into (≥1 Harnery hook
wired), so a bare `.claude/settings.json` never false-warns. The fix is always
the same idempotent, additive `harn init`; removed/renamed events show up as
`orphaned` and are reconciled with `harn uninstall` then `harn init`.

The shared types + "is this wired?" matcher moved into a new
`core/hooks/harness/wiring.ts` so the writer (`init`), the doctor check, and the
session-start renderer can't drift from one another.
