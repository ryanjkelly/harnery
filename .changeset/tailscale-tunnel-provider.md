---
"harnery": patch
---

Add Tailscale as a selectable tunnel provider. `harn tunnel up --provider tailscale` now exposes the existing Host-rewriting gate through Tailscale Serve by default, with `--visibility public` switching to Tailscale Funnel, while the existing Cloudflare quick tunnel remains the default provider.

Resolve the MagicDNS URL before starting the Tailscale share so an unresolvable name fails cleanly instead of leaving a live, stateless exposure, and warn on `tunnel down` when the `serve`/`funnel off` teardown fails so a surviving mapping can't silently keep the machine exposed.
