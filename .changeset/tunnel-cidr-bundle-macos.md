---
"harnery": minor
---

`tunnel` runs on macOS and Windows and from a single-file host bundle, and its gate allowlist understands ranges. Entries in `tunnel allow` can be CIDR ranges (`203.0.113.0/24`, `2601:db8:1:2::/64`) as well as addresses, and IPv6 spellings are normalized. `tunnel allow add --current` allows this machine's public IPv4 /32 and IPv6 /64 as Cloudflare sees them, replaces only the entries the previous `--current` added, and reloads running gates so public URLs are kept. When the gate script is not on disk (a bundled host CLI), the CLI re-executes itself with a hidden `tunnel gate` task. Process and port discovery gains macOS and Windows paths and tolerates missing tools. `HARNERY_CLOUDFLARED` and the config's `cloudflared_path` name an explicit cloudflared binary, and `HARNERY_TUNNEL_DIR` moves tunnel state. Host programs can mount the command with `registerHarneryTunnelCommand` and refresh the allowlist with `refreshTunnelCurrentAddress`.
