---
"harnery": minor
---

Add two toolkit subpaths for embedding hosts that work with the 1Password CLI. `harnery/lib/op` provides `createOpClient(config)`: it finds `op` (including `op.exe` from WSL and an optional host forwarding helper), reads fields with stdin ignored, writes items through a whole-item template so untouched fields survive, masks concealed and OTP values, explains common `op` refusals, translates aliased account addresses to account IDs, refuses to write a secret to a path Git would commit, and enforces a read-only write policy before any process starts. `harnery/lib/creds` provides `createCredsEngine` and `registerCredsCommand` over a host registry of pull scripts and the files they write: pull reuses usable local files before resolving 1Password, heal repairs missing or rotated files with per-key retry backoff and always exits 0, check reports file age and host probes, and verify confirms every item and field the scripts read still resolves.
