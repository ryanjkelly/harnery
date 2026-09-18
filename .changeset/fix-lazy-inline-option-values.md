---
"harnery": patch
---

Load the selected lazy command when a root option carries its value inline,
such as `--format=json`. The scanner now leaves the following command token in
place instead of mistaking it for a separate option value.
