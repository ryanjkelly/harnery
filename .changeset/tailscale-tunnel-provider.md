---
"harnery": patch
---

Add Tailscale as a selectable tunnel provider. `harn tunnel up --provider tailscale` now exposes the existing Host-rewriting gate through Tailscale Serve by default, with `--visibility public` switching to Tailscale Funnel, while the existing Cloudflare quick tunnel remains the default provider.
