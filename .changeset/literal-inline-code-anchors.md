---
"harnery": patch
---

Keep literal inline-code contents when checking Markdown heading anchors. Angle-bracket text and underscores inside matching code spans now survive markup removal, while actual HTML tags outside code still disappear. Matching backtick runs and duplicate headings retain their heading-anchor behavior.
