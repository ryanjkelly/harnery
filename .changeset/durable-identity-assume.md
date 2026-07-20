---
"harnery": minor
---

Add `harn agents identity assume <name-or-id>` for durable role continuity across harness sessions. The command reuses or mints a persona UUID, refuses a live local or known remote namesake, appends an auditable latest-wins binding to `.name-history`, emits `identity.assumed`, and synchronously reprojects the heartbeat. Heartbeat healing, event replay, `agents trace`, and the web identity cache now preserve the assumed role; `.identity-index.json` remains derived and is never edited by the command.

The injected coordination instructions now teach replacement sessions to use this command instead of editing state files. Re-run `harn init` in an existing project to refresh that managed block.
