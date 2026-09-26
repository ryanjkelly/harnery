---
"harnery": minor
---

`tunnel up` now requires a path scope. Pass `--allow-path <prefix>` (repeatable) to name the URL paths the tunnel shares; the gate refuses every other request with a 403 "not shared" page and a `path-deny:` log line, for every provider and for WebSocket upgrades. `--allow-path /` publishes the whole upstream, and `up` with no scope refuses to start. The gate also refuses request paths that carry an encoded slash, backslash, dot, or percent sign. The scope is saved in tunnel state as `allow_paths`, shown by `tunnel status`, and kept by `tunnel reload`; an instance saved without a scope cannot be reloaded and must be started again with `up`. Artifact delivery cards use a dashboard tunnel only when its scope covers `/browse` and `/files`. Previously a tunnel in front of the Harnery web UI published the whole dashboard, including the repository file viewer.
