---
"harnery": patch
---

docs-lint: exempt leading-underscore filenames (e.g. `_template.md`) from the kebab-case naming check. The underscore prefix is a deliberate "this is a template, not a real doc" convention, so these files no longer emit a `non-kebab-filename` warning.
