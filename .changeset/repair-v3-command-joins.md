---
"harnery": patch
---

Status observations now use the native owner ID when a new V3 projection has no cache. Previously, they tried to join the hook generation with the canonical session fingerprint and emitted `hook_generation_not_joinable`.
