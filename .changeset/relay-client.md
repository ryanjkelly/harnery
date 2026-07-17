---
"harnery": minor
---

Presence relay client transport (ADR 0016 phase 2c) + `harn relay serve` self-host. With `.harnery/config.jsonc` `{"presence":{"relay":"wss://…"}}` set, hooks lazy-start a per-machine daemon (`harn presence relay-daemon`) that holds the relay WebSocket: publishes the encrypted presence blob on every heartbeat change (fs.watch, 60s keepalive), caches received peer blobs at `.harnery/presence/remote/`, auto-reconnects with jittered backoff, and exits when the machine goes idle. `readRemoteMachines` (and every render surface on it) now merges both transports — git refs and relay cache — freshest per machine. `harn relay serve` runs the same wire protocol as the Cloudflare worker for self-hosters (Bun-only). Relay unreachable → silent degradation to the git-refs floor.
