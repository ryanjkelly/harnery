---
"harnery": minor
---

`harn grep` is now ripgrep-backed and searches repos in parallel. When `rg` is
on PATH it is used automatically (GNU `grep` remains the transparent fallback;
`HARNERY_GREP_ENGINE=rg|grep` forces one), driven with equivalent flags so
results are identical across engines — pinned by a new engine-parity test
suite, with `scripts/bench-grep.ts` to reproduce the numbers. On a real
24-repo monorepo the search phase of an `--all-repos` sweep dropped 863ms →
147ms (warm cache; the gap widens cold), and the sweep's end-to-end wall time
dropped ~6.8s → ~1.1s.

Correctness and output changes that ride along:

- `--all-repos` no longer double-scans and double-reports submodule matches:
  the parent scan prunes submodule directories, so each match is attributed to
  exactly one repo (a previous sweep returning 90 rows now returns the 56
  unique ones).
- Matches are sorted (file, then line) for stable cross-run, cross-engine
  output; engine order is kept in `-C` context mode so groups stay adjacent.
- `-c` no longer emits `path:0` rows for match-less files (GNU grep prints
  them; ripgrep doesn't — the envelope now filters them on both engines).
- Leading `./` is stripped from file paths.
- Partial failures (an unreadable file mid-walk) return collected matches
  instead of throwing everything away.
- New `HarneryProgramContext.grepExcludeDirs` lets a host CLI add its
  generated-mirror directories to the default skip list.
- The JSON envelope gains an `engine` field.
- New `--files` mode: treat `<pattern>` as a filename glob and list matching
  files (`rg --files` when available, POSIX `find` fallback; same excludes,
  scoping, `-i`, `--exclude`, and `--limit`; content-search flags are
  rejected).
- Fixed rg glob ordering: positive globs (`--include`, `--lang`, the `--files`
  pattern) are now emitted before negative excludes, so an exclude always wins
  (rg globs are last-match-wins; previously `--include '*.md'` could
  re-include files inside an excluded directory).
