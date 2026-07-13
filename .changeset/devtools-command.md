---
"harnery": minor
---

Add `harn devtools`: a local-only status reader for the three AI coding agents Harnery supports — Claude Code, Codex, and Cursor. Reports logged-in status, plan / seat tier, auth expiry, session counts, and (where the tool records them locally) rate-limit / quota windows with reset timestamps, in one uniform `ToolStatus` shape. Reads files on disk only — no network, no vendor API; auth tokens are inspected for their non-secret claims (email, plan, expiry) and never read into the output. Signals a tool keeps server-side (Cursor usage + billing, Claude's live rate-limit windows) surface as blank with a note rather than a guess. `--usage` adds an opt-in, mtime-windowed scan of local transcripts for approximate token totals.
