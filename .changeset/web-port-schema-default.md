---
"harnery": patch
---

Fix the published JSON config schema (`schemas/config.schema.json`): `web.port` declared its default as `7777`, but `harn web up` actually defaults to `9000`. Editors reading the `$schema` were suggesting the wrong port.
