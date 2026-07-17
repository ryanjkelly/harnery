# harnery presence relay (Cloudflare Workers host)

The optional live-socket upgrade for harnery's cross-machine presence
(decision record 0016). One Durable Object per room fans presence frames out
to every connected machine; the WebSocket Hibernation API keeps idle
connections effectively free. Works on the Workers **free plan**
(SQLite-backed Durable Objects).

The relay is deliberately blind: room ids are opaque capability strings
derived client-side from the repo identity, sender ids are HMAC-derived, and
every payload is AES-GCM ciphertext end-to-end. No accounts, no configuration,
no plaintext.

The shared wire protocol lives in
[`src/core/presence/relay-protocol.ts`](../../src/core/presence/relay-protocol.ts);
this worker is one of two hosts (the other is the Bun `harn relay serve`
self-host).

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=...   # Workers Scripts:Edit (+ zone perms for the custom domain)
export CLOUDFLARE_ACCOUNT_ID=...
cd relay/worker
bunx wrangler deploy
```

The committed `wrangler.toml` routes `relay.harnery.com` (the reference public
deployment). To run your own: change or delete the `routes` entry — with no
route, wrangler prints a `*.workers.dev` URL, and clients point at it via
`.harnery/config.jsonc` → `{ "presence": { "relay": "wss://<your-url>" } }`.

## Protocol (v1)

- `GET /healthz` → `{ ok: true }`
- `GET /v1/room/<32-hex-room-id>` + `Upgrade: websocket` → joins the room
  - on join the relay replays the last cached frame per sender (warm join),
    then sends `{ t: "hello", peers: <n> }`
  - clients send `{ t: "pub", sender, iv, ct }`; the relay caches it by
    `sender` (Durable Object storage, 15-minute TTL) and fans it out to every
    other socket in the room

Limits: 16KB per frame, 64 sockets per room, 10-frame burst / 1 frame per 2s
per socket. All enforcement is silent-drop.
