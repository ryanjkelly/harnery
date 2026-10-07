---
"harnery": patch
---

Fix tunnel path-scope imports in the packaged Node runtime. The built imports now include the file extension, so loading the CLI no longer fails with `ERR_MODULE_NOT_FOUND`.
