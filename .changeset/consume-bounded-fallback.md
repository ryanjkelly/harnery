---
"harnery": patch
---

`consumeSince` no longer reads the whole event stream on its fall-through path. When the cursor missed the 2MB tail window it did a `readFileSync` of the entire `.harnery/events.ndjson`, which throws V8's max-string-length error ("Cannot create a string longer than 0x1fffffe8 characters") once the append-only ledger passes ~512MB, silently aborting Stop-hook heartbeat projection (caught + logged as `stop-projection`). The fall-through now reads at most a capped tail (`fallbackCapBytes`, default 64 MiB, env `HARNERY_AGENT_COORD_FALLBACK_CAP_BYTES`), dropping the partial leading line, so projection stays correct on an arbitrarily large ledger. Events older than the cap are stale for coord-state purposes and the projector is idempotent, so the bounded replay is safe.
