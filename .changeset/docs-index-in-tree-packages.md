---
"harnery": patch
---

Scan first-level in-tree packages for `docs/audits` and `docs/issues` indexes, not only the host root and git submodules. Packages that live in the monorepo without a `.git` dir (so they are not submodules) were skipped, and their README tables went stale.
