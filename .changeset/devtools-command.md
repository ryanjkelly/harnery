---
"harnery": minor
---

Add `harn devtools`: a status reader for the three AI coding agents Harnery supports — Claude Code, Codex, and Cursor. Reports logged-in status, plan / seat tier, auth expiry, session counts, and rate-limit / quota windows with reset timestamps, in one uniform `ToolStatus` shape. The default report reads files on disk only — no network; auth tokens are inspected for their non-secret claims (email, plan, expiry) and never read into the output. `--usage` adds an opt-in, mtime-windowed scan of local transcripts for approximate token totals.

Opt-in network enrichments (all skipped by `--no-api`, cached two minutes under `~/.cache/harnery/devtools/`) fill the live signals each tool keeps server-side, authenticating with the credential already on disk:

- **Claude Code** reads the OAuth token from `~/.claude/.credentials.json` and calls `api.anthropic.com/api/oauth/usage` (the endpoint `/usage` uses) for the 5h + weekly rate-limit windows and extra-usage spend. That endpoint is sharply rate-limited and shared with Claude Code's own usage panel, so the result is cached and a rate-limited fetch degrades to a note without being cached.
- **Cursor** reads the IDE session token from `state.vscdb` and calls cursor.com's dashboard API (the Spending-page request) for the billing cycle + total/API/first-party percent-used + on-demand spend. No API key needed.
- **Cursor Cloud Agents** — when a Cursor API key is stored, adds Cloud Agent activity from the public `/v0` API (individual Cursor plans expose no usage/spend there).

`ToolStatus` gains `usage` (Cursor billing) and a shared `spend` (Claude extra-usage / Cursor on-demand overage); `quota[]` is now populated live for Claude Code as well as Codex.

The network enrichment is disciplined to protect these shared endpoints: results are cached per account (keyed by a token fingerprint) for five minutes, so the dashboard touches the network at most once per tool per five minutes no matter how often it re-renders, and switching accounts shows the new account's numbers immediately; a 429 arms a `Retry-After` cooldown that suppresses further calls (serving last-known-good) so a rate limit can't cascade; and every request carries the tool's own client identity with a live version — `claude-cli/<version> (external, cli)` + `x-app: cli` for Claude (version read from the newest session transcript), Cursor's Electron UA embedding the `state.vscdb` version — so it reads as first-party traffic. `harn devtools doctor` makes one cache-bypassing call per endpoint to detect header/schema drift (`auth_rejected` / `shape_changed`), reported distinctly from a rate limit.

Codex is read from local files only and is multi-install aware: when a machine has more than one Codex install (e.g. a WSL CLI and the Windows desktop app, each its own account), the reader locks onto the active install (whichever owns the freshest rollout) and reads auth + rate limits from it, so accounts never mix. Auth expiry is reported from the access token (which outlives the id token), so a healthy login is no longer shown as expired.
