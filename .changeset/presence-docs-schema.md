---
"harnery": patch
---

Documentation completeness for presence/relay: README feature bullet, coord-layer concepts section, config-schema reference (`presence` key), and the shipped `schemas/config.schema.json` now declares `tools`, `workflow`, `skills`, and `presence` (it uses `additionalProperties: false`, so editors were flagging valid configs carrying those keys).
