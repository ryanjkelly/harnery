---
"harnery": patch
---

Trim artifact slug edges with fixed-length patterns.

`normalizeSlug` trimmed leading and trailing dashes with `/^-+|-+$/g`. Collapsing
every non-alphanumeric run to a single `-` already runs first, so no input reaching
that pattern can hold two adjacent dashes and the quantifier never had more than one
character to match. The pattern was still polynomial when read on its own, which is
how static analysis reports it and how it would behave if the collapse above it ever
moved or changed. The edges are now trimmed with `/^-/` and `/-$/`, which cannot
backtrack. Output is unchanged on every input.
