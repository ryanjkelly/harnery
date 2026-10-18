---
"harnery": patch
---

The ZIP toolkit now accepts an archive, base, or destination whose parent directories pass through a symbolic link, such as `/tmp` and `/var` on macOS. It still refuses a link at the named path itself or anywhere below it.
