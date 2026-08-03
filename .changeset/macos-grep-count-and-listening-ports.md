---
"harnery": patch
---

Fix `grep -c` and tunnel port detection on hosts without GNU tooling

`grep -c` returned no rows on any host whose only search engine is BSD grep
(notably macOS without ripgrep). BSD grep honours `--null` for content and `-l`
records but ignores it under `-c`, emitting `<path>:<count>` where GNU grep emits
`<path>NUL<count>`, so every count row was discarded as unframed output. The
count decoder now also reads the unframed shape, splitting on the last colon so a
path containing colons still parses.

`tunnel`'s listening-port probe shelled out to `ss` (iproute2, Linux-only) and
silently returned an empty set elsewhere, reporting every port as free. That let
`allocateGatePort` hand out an occupied port and made the reload port-release
check inert. It now falls back to `lsof` when `ss` is unavailable.
