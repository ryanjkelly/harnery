---
"harnery": minor
---

`doctor`: flag an adapter whose CLI is installed but that has no hooks wired

The `adapter hooks` check only reported drift for an adapter already carrying at
least one Harnery hook. An adapter with none — including one whose settings file
does not exist — was skipped before any check ran, so a project could have Codex
or Cursor installed, have no hook manifest for it at all, and still see every
`doctor` check pass. Agents starting a session through that adapter registered
nothing, and nothing in the output said so.

`doctor` now warns when the project plainly uses Harnery hooks (some other
adapter is wired) and the unwired adapter's CLI is installed, with the
`init --adapter <id>` remedy. Both conditions are required, so a project that has
never run `init` and a project without that CLI both stay quiet.

Adds `summarizeAdapterWiring()` to `core/hooks/adapter/wiring.ts` for the
wired/unwired split. `loadAdapterWiring()`'s contract is unchanged: it still
reports drift only, and a bare settings file still never false-warns.
