---
"harnery": patch
---

`tunnel down` no longer kills a live tunnel that shares a stale instance's old gate port. After a reboot a new instance can be allocated a stale record's port; stopping the stale record used to sweep that port, kill the live gate, and make the heal loop reroll the live tunnel's public URL on every pass. The orphan sweep also passes `--` to `pgrep`, which had read the `--url ...` provider pattern as an unknown option and never matched a stray `cloudflared`.
