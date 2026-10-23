---
"harnery": patch
---

Prevent incomplete layout and content scans from passing. Add an explicit traversal budget for larger pages. The clipping check supports pure two-dimensional translations and keeps unsupported transforms unknown.
