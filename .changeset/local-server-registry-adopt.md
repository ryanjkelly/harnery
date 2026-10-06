---
"harnery": minor
---

Add `servers adopt` to register running servers that never registered, and per-type port ranges: `.harnery/config.jsonc` `servers.port_ranges` with `servers port <type>` and `allocateServerPort()`. `servers.idle_hours` and `servers.owner_stale_hours` set the `gc` defaults.
