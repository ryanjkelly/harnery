---
"harnery": minor
---

Expand a leading `~/` and `{uid}` in project finalization roots before resolving paths or checking Git repositories. Skip roots requiring a numeric user ID on Windows, and report unknown tokens as doctor warnings while leaving them literal.

Report scheduled backup setup in doctor using the existing local prerequisite inspection. Missing setup produces an informational runtime finding that never fails doctor; complete setup produces an ok finding, and projects without a schedule get no backup setup line. JSON summaries include the info count.
