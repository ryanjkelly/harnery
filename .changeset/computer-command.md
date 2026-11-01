---
"harnery": minor
---

New opt-in `computer` command drives a Windows desktop (native or from WSL2)
through one pinned, checksum-verified desktop driver, called through its CLI.
It stays inert until a project sets `"computer": { "enabled": true }` in
`.harnery/config.jsonc`. `computer install` previews the pinned download and
applies it with `--yes`; `status`, `up`, `down`, `doctor`, `tools`, and
`describe <tool>` manage and inspect the driver; `call <tool> [json]` runs one
tool call. Each call takes a desktop lease shared by every agent on the
machine, so a second agent waits (bounded) and then exits 3 naming the holder.
`computer lease status|acquire|release` manage it directly. A call without
`session` uses the agent's name, and inline base64 screenshots are redacted
from the output unless `--keep-screenshot` is passed. With computer use
enabled, `init` also renders a `harn-computer` skill and one pointer line in
the instructions block; other projects' rendered output is unchanged. New
config keys: `computer.enabled`, `computer.idle_seconds`, and
`computer.wait_seconds`, read by `readComputerConfig()`.
