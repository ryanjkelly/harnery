---
"harnery": minor
---

Add `harn tunnel reload` so an allowlist change no longer costs you the tunnel URL.

Each gate reads the Cloudflare IP allowlist once, from its environment, when it starts. Editing the config therefore did nothing to a tunnel already running, and the only remedy on offer was a full `down`/`up`. That is a bad trade: a quick tunnel's hostname is minted by `cloudflared` at startup, so restarting to admit one new IP hands back a different `*.trycloudflare.com` address and breaks every link already shared. The fix for "I cannot reach this link" destroyed the link.

`reload` restarts the gate in place and leaves the provider process running. `cloudflared` only ever forwards to the gate's local port, so the hostname survives and the edge reconnects on its own:

```bash
harn tunnel allow add 1.2.3.4
harn tunnel reload --all
```

Three details are deliberate. `--all` targets live instances only, counting and skipping stale state files rather than failing on them, because a long-running machine accumulates those and the common path after `allow add` should exit clean. Reloading a single stale instance refuses instead of proceeding, since a dead provider means the URL is already gone and no gate restart can bring it back. And the refusal is checked before anything is killed, so it cannot leave an instance with a broken URL *and* a stopped proxy, nor reap a live gate that happens to have inherited a stale instance's recorded port.

`allow add` and `allow rm` now point at `reload` and name only the tunnels that are actually running, instead of listing every state file ever written.
