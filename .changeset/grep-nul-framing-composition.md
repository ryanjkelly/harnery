---
"harnery": minor
---

grep: NUL filename framing, materialized context, exact truncation, and file-level composition.

New flags: `--and <pattern>` / `--without <pattern>` (file-level boolean composition, repeatable), `-A`/`-B` (per-side context overriding `-C`), `-q/--quiet` (exit 0/1 status, no output), and multi-value `--lang` (`--lang ts,tsx` or repeated). JSON envelope additions (additive): rows carry `kind: "match" | "context"`; the top level gains always-present `and_patterns`/`without_patterns` arrays.

Corrections: `-C` context rows previously parsed as fake matches (garbled output, inflated `total_matches`/`total_files`, context consuming `--limit`) — context is now materialized from file reads after selection, with correct kinds, merged windows, and free context rows. Filenames are NUL-framed (`--null` on both engines), so colon/dash/space-bearing paths parse correctly. `truncated` is now exact: a search with exactly N results under `--limit N` no longer reports true. Invalid numeric flag values and meaningless flag combinations (context with `-l`/`-c`/`--files`/`-q`, composition with `--files`, quiet with `--json`/`-l`/`-c`/`--limit`) fail loudly before an engine spawns.
