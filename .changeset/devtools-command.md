---
"harnery": minor
---

Add `harn devtools`: a status reader for the three AI coding agents Harnery supports — Claude Code, Codex, and Cursor. Reports logged-in status, plan / seat tier, auth expiry, session counts, and rate-limit / quota windows with reset timestamps, in one uniform `ToolStatus` shape. The default report reads files on disk only — no network; auth tokens are inspected for their non-secret claims (email, plan, expiry) and never read into the output. `--usage` adds an opt-in, mtime-windowed scan of local transcripts for approximate token totals.

Two opt-in network enrichments run for Cursor (both skipped by `--no-api`). The first needs no API key: it reads the IDE's own session token from `state.vscdb` and calls cursor.com's dashboard API — the same request Cursor's Spending page makes — to fill `usage` (billing-cycle end, total/API/first-party percent used, on-demand spend cap). The second, when a Cursor API key is stored, adds Cloud Agent activity from the public `/v0` API. The session-token path is what surfaces the billing numbers; the key path only adds cloud agents (individual Cursor plans expose no usage/spend on the public API).
