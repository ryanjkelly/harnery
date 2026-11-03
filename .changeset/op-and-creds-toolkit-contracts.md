---
"harnery": minor
---

Add two toolkit subpaths for embedding hosts that work with the 1Password CLI. `harnery/lib/op` defines the host contract for finding and running `op`, reading and writing items, a write policy enforced before any process starts, an optional forwarding-helper resolver, and machine-local credential mirrors. `harnery/lib/creds` defines the contract for a registry of pull scripts and the files they write, revision-driven re-pulls, retry backoff, item verification, and host probes. This release ships the types only; the implementations follow.
