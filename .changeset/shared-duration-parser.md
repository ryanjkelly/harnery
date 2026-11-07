---
"harnery": patch
---

Read every relative duration flag (`events --since/--until`, `admission history --since`, `web performance --since`, `storage maintain --budget`, `backup snapshot --if-stale`, `agents` timeouts) with one parser, so each accepts the same units: `ms`, `s`, `m`, `h`, `d`, `w`, case-insensitive, with decimals such as `1.5h`. Each command keeps its own limits.
