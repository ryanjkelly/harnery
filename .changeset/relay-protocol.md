---
"harnery": minor
---

Presence relay, phase 2 groundwork (ADR 0016): the shared relay wire protocol (`src/core/presence/relay-protocol.ts` — HKDF capability-room derivation from repo identity, AES-GCM E2E payload encryption, opaque HMAC sender ids, frame parsing/caps) and the Cloudflare Durable Objects relay host (`relay/worker/` — one DO per room, WebSocket Hibernation API, warm-join cache in DO storage, per-socket rate limits; deployable to any Cloudflare account with `wrangler deploy`, free-plan compatible). The reference public deployment runs at relay.harnery.com. Client transport (hooks → relay) ships next.
