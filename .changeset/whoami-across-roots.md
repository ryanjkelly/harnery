---
"harnery": patch
---

`agents whoami` names the calling agent when it acts on another project through `HARNERY_COORD_ROOT_OVERRIDE`, looking the session up in the project that registered it and reporting both roots, instead of failing with `session_generation_unavailable`.