---
"harnery": patch
---

Reword user-facing CLI copy to drop em-dash overuse. Command and option
descriptions, error and warning messages, agent-facing nudges, and the web
dashboard's labels now use commas, colons, or parentheses in place of
em-dashes. Two structural follow-ups: the scratchpad file-header delimiter
changed from an em-dash to a colon (`# Scratchpad: agent-<name>`), unifying the
writer, the parser, and the regexes that recover agent names from archived
scratchpads (existing files regenerate on the next write); and the missing-value
display glyph now routes through a single `NO_DATA` constant per module tree (the
rendered mark is unchanged).
