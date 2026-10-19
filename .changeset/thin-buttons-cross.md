---
"harnery": minor
---

Tunnel readiness now requires the original registration receipt and saved process generations. Commands retain unknown state instead of reusing or replacing it, and file links use only verified ready tunnels.

The toolkit replaces `isTunnelStateLive` with `tunnelReadiness` and a mandatory verifier. Embedding hosts can use `createTunnelReadinessVerifier` from `harnery/core/servers`. Cloudflare state uses only `cloudflared_pid` and `cloudflared_start_token`; obsolete provider fields remain unknown and cannot authorize actions.
