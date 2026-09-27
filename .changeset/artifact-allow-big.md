---
"harnery": minor
---

Add `artifacts allow-big <ref>`, which records the `create --big` acknowledgement on an existing workspace. Work that grows past the per-bundle ceiling after creation can now be exempted from that ceiling while its expiry stays in force; previously the only protection was a hold, which also suspends expiry. The size warning in `list` and `show` now points to this command, and `artifactCapabilities()` reports `allow_big_after_create: true`.
