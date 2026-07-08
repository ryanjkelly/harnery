---
"harnery": patch
---

`harn docs sweep` no longer spawns one `git log` per markdown file. Ages come from a single `git log --name-only` per repo, which drops a large-monorepo sweep from about a minute to under a couple of seconds and stops the command looking hung when piped.
