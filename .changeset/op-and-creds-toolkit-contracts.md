---
"harnery": minor
---

Add two toolkit subpaths for embedding hosts that work with the 1Password CLI. `harnery/lib/op` provides `createOpClient(config)`: it finds `op` (including `op.exe` from WSL and an optional host forwarding helper), reads fields with stdin ignored, writes items through a whole-item template so untouched fields survive, masks concealed and OTP values, explains common `op` refusals, translates aliased account addresses to account IDs, refuses to write a secret to a path Git would commit, and enforces a read-only write policy before any process starts. `harnery/lib/creds` defines the contract for a registry of pull scripts and the files they write, revision-driven re-pulls, retry backoff, item verification, and host probes; its implementation follows.
